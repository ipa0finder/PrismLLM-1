// Client-side FreeLLMAPI-style router: key rotation, rate-limit tracking, failover, strategies.
export type Role = 'system' | 'user' | 'assistant';
export interface Msg { role: Role; content: string }
export interface ModelDef { id: string; label: string }
export interface ProviderDef { id: string; name: string; baseUrl: string; models: ModelDef[]; rpm?: number }
export interface KeyEntry { id: string; provider: string; key: string; cooldownUntil: number; ok: number; fail: number; lastUsed: number; lastError?: string }
export type Strategy = 'failover' | 'fastest' | 'reliable' | { provider: string; model: string };
export interface Res { status: number; headers: Record<string, string>; body: AsyncIterable<string> }
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }, signal?: AbortSignal) => Promise<Res>;
export interface ChatEvent { meta?: string; delta?: string }
export interface RouterCfg { mode: 'direct' | 'remote'; remoteUrl: string; remoteKey: string; remoteModel: string }

// Starter catalog (OpenAI-compatible endpoints). Model IDs drift: use "Sync models" in Settings to pull live lists.
// rpm values are conservative local throttles, not provider guarantees.
export const DEFAULT_CATALOG: ProviderDef[] = [
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', rpm: 30, models: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' }] },
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', rpm: 30, models: [{ id: 'llama-3.3-70b', label: 'Llama 3.3 70B' }] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', rpm: 20, models: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)' }] },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', rpm: 10, models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', rpm: 30, models: [{ id: 'mistral-small-latest', label: 'Mistral Small' }] },
];

interface Attempt { pid: string; name: string; base: string; model: string; key: string; entry?: KeyEntry }
const strip = (u: string) => u.replace(/\/+$/, '');
async function readAll(b: AsyncIterable<string>) { let s = ''; for await (const c of b) s += c; return s; }

export class Router {
  catalog: ProviderDef[] = structuredClone(DEFAULT_CATALOG);
  keys: KeyEntry[] = [];
  stats: Record<string, { lat: number; ok: number; fail: number }> = {};
  cfg: RouterCfg = { mode: 'direct', remoteUrl: '', remoteKey: '', remoteModel: 'auto' };
  onChange: () => void = () => {};
  private hits: Record<string, number[]> = {};
  constructor(private tx: Transport) {}

  private st(id: string) { return (this.stats[id] ??= { lat: 0, ok: 0, fail: 0 }); }
  private score(id: string) { const s = this.st(id); return (s.ok + 1) / (s.ok + s.fail + 2); }

  private candidates(strategy: Strategy): Attempt[] {
    const now = Date.now();
    let provs = this.catalog.filter(p => this.keys.some(k => k.provider === p.id));
    let model = (p: ProviderDef) => p.models[0]?.id ?? '';
    if (typeof strategy === 'object') { provs = provs.filter(p => p.id === strategy.provider); model = () => strategy.model; }
    else if (strategy === 'fastest') provs.sort((a, b) => this.st(a.id).lat - this.st(b.id).lat); // unexplored (0) first
    else if (strategy === 'reliable') provs.sort((a, b) => this.score(b.id) - this.score(a.id));
    const out: Attempt[] = [];
    for (const p of provs) {
      const ks = this.keys.filter(k => k.provider === p.id && k.cooldownUntil <= now)
        .filter(k => !p.rpm || (this.hits[k.id] ?? []).filter(t => now - t < 60000).length < p.rpm)
        .sort((a, b) => a.lastUsed - b.lastUsed); // least-recently-used first = rotation
      for (const k of ks) out.push({ pid: p.id, name: p.name, base: p.baseUrl, model: model(p), key: k.key, entry: k });
    }
    return out;
  }

  private remote(strategy: Strategy): Attempt[] {
    let base = strip(this.cfg.remoteUrl); if (!/\/v1$/.test(base)) base += '/v1';
    const model = typeof strategy === 'object' ? strategy.model : this.cfg.remoteModel || 'auto';
    return [{ pid: 'remote', name: 'FreeLLMAPI', base, model, key: this.cfg.remoteKey }];
  }

  private penalize(a: Attempt, status: number, h: Record<string, string>, body: string, dead: Set<string>) {
    const k = a.entry; if (this.st(a.pid)) this.st(a.pid).fail++;
    if (!k) return;
    k.fail++; k.lastError = `HTTP ${status}: ${body.slice(0, 120)}`;
    if (status === 429) { const ra = parseFloat(h['retry-after'] ?? ''); k.cooldownUntil = Date.now() + (ra > 0 ? ra * 1000 : 60000); }
    else if (status === 401 || status === 403) k.cooldownUntil = Date.now() + 3600000;
    else if (status === 400 || status === 404 || status === 422) dead.add(a.pid); // model/params unsupported: skip provider
    else k.cooldownUntil = Date.now() + 30000;
    this.onChange();
  }

  async *chat(messages: Msg[], strategy: Strategy, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const attempts = this.cfg.mode === 'remote' ? this.remote(strategy) : this.candidates(strategy);
    if (!attempts.length) throw new Error(this.cfg.mode === 'remote' ? 'Set the server URL in Settings.' : 'No usable keys. Add a provider key in Settings (or wait for cooldowns).');
    const errors: string[] = []; const dead = new Set<string>();
    for (const a of attempts) {
      if (dead.has(a.pid) || signal?.aborted) continue;
      const t0 = performance.now(); let started = false;
      if (a.entry) { a.entry.lastUsed = Date.now(); (this.hits[a.entry.id] ??= []).push(Date.now()); }
      try {
        const res = await this.tx(`${strip(a.base)}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` },
          body: JSON.stringify({ model: a.model, messages, stream: true }),
        }, signal);
        if (res.status !== 200) {
          const txt = await readAll(res.body); errors.push(`${a.name}: HTTP ${res.status}`);
          this.penalize(a, res.status, res.headers, txt, dead); continue;
        }
        let buf = '';
        for await (const chunk of res.body) {
          buf += chunk; let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim(); if (d === '[DONE]') continue;
            let j: any; try { j = JSON.parse(d); } catch { continue; }
            if (j.error) throw new Error(j.error.message ?? 'provider error');
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) {
              if (!started) {
                started = true; const s = this.st(a.pid), ttfb = performance.now() - t0;
                s.lat = s.lat ? s.lat * 0.7 + ttfb * 0.3 : ttfb;
                yield { meta: `${a.name} · ${a.model}` };
              }
              yield { delta };
            }
          }
        }
        if (started) { this.st(a.pid).ok++; if (a.entry) { a.entry.ok++; a.entry.lastError = undefined; } this.onChange(); return; }
        errors.push(`${a.name}: empty response`); this.penalize(a, 0, {}, 'empty', dead);
      } catch (e: any) {
        if (signal?.aborted || e?.name === 'AbortError') return;
        if (started) throw e; // mid-stream failure: surface it, don't silently restart
        errors.push(`${a.name}: ${e?.message ?? e}`); this.penalize(a, 599, {}, String(e?.message ?? e), dead);
      }
    }
    throw new Error('All routes failed.\n' + errors.slice(-5).join('\n'));
  }

  async testKey(k: KeyEntry): Promise<string> {
    const p = this.catalog.find(x => x.id === k.provider); if (!p) return 'Unknown provider';
    try {
      const r = await this.tx(`${strip(p.baseUrl)}/models`, { method: 'GET', headers: { Authorization: `Bearer ${k.key}` } });
      const body = await readAll(r.body);
      if (r.status === 200) { k.lastError = undefined; k.cooldownUntil = 0; this.onChange(); return 'Key works'; }
      k.lastError = `HTTP ${r.status}`; this.onChange(); return `HTTP ${r.status}: ${body.slice(0, 100)}`;
    } catch (e: any) { return `Network error: ${e?.message ?? e}`; }
  }

  /** Pull live model lists from every provider that has a key. Returns count of providers updated. */
  async syncCatalog(): Promise<number> {
    let n = 0;
    for (const p of this.catalog) {
      const k = this.keys.find(x => x.provider === p.id); if (!k) continue;
      try {
        const r = await this.tx(`${strip(p.baseUrl)}/models`, { method: 'GET', headers: { Authorization: `Bearer ${k.key}` } });
        const j = JSON.parse(await readAll(r.body)); if (r.status !== 200) continue;
        let ids: string[] = (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
        ids = ids.filter(id => !/embed|whisper|tts|guard|moderation|rerank|image|audio|dall/i.test(id));
        if (p.id === 'openrouter') ids = ids.filter(id => id.endsWith(':free'));
        if (ids.length) { p.models = ids.slice(0, 40).map(id => ({ id, label: id })); n++; }
      } catch { /* skip provider */ }
    }
    this.onChange(); return n;
  }
}
