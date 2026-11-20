import { Router, Strategy, Msg, KeyEntry } from './router';
import { transport, haptic, share } from './native';
import { Chat, Settings, Secrets, loadAll, saveChats, saveSettings, saveSecrets, exportBackup, importBackup, uid } from './storage';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

// ---------- Markdown + code highlighting (dependency-free) ----------
const TOK = /(\/\/.*|#.*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(const|let|var|function|return|if|else|for|while|import|from|export|class|def|async|await|new|try|catch|throw|true|false|null|None|self|in|of)\b|\b(\d+\.?\d*)\b/g;
function hl(code: string) {
  let o = '', i = 0;
  for (const m of code.matchAll(TOK)) {
    o += esc(code.slice(i, m.index));
    o += `<span class="t${m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n'}">${esc(m[0])}</span>`;
    i = m.index! + m[0].length;
  }
  return o + esc(code.slice(i));
}
function md(src: string) {
  const codes: string[] = [];
  const t = src.replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_, l, c) => {
    codes.push(`<div class="code"><div class="ch"><span>${esc(l || 'code')}</span><button data-copy>Copy</button></div><pre><code>${hl(c.replace(/\n$/, ''))}</code></pre></div>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const inl = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  let out = '', list = '';
  const close = () => { if (list) { out += `</${list}>`; list = ''; } };
  for (const line of t.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim()))) { close(); out += codes[+m[1]]; }
    else if ((m = /^\s*[-*] (.*)/.exec(line))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inl(m[1])}</li>`; }
    else if ((m = /^\s*\d+\. (.*)/.exec(line))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inl(m[1])}</li>`; }
    else if ((m = /^(#{1,3}) (.*)/.exec(line))) { close(); out += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; }
    else if (!line.trim()) close();
    else { close(); out += `<p>${inl(line)}</p>`; }
  }
  close(); return out;
}

// ---------- State ----------
let chats: Chat[] = [], S: Settings, X: Secrets, chat: Chat, busy = false, ctl: AbortController | null = null, pendingDel = '';
const router = new Router(transport);
const msgsEl = $('#msgs'), input = $('#input') as HTMLTextAreaElement, sheet = $('#sheet'), drawer = $('#drawer'), sendBtn = $('#send');

const debounce = (fn: () => void, ms: number) => { let t: number; return () => { clearTimeout(t); t = window.setTimeout(fn, ms); }; };
const persistChats = debounce(() => saveChats(chats), 400);
const persistSecrets = debounce(() => saveSecrets(X), 400);
router.onChange = persistSecrets;
function wire() { router.keys = X.keys; router.catalog = S.catalog; router.cfg = { mode: S.mode, remoteUrl: S.remoteUrl, remoteKey: X.remoteKey, remoteModel: S.remoteModel }; }
const saveAll = () => { wire(); saveSettings(S); saveSecrets(X); };

const label = (s: Strategy) => s === 'failover' ? 'Auto-Failover' : s === 'fastest' ? 'Fastest' : s === 'reliable' ? 'Highest Reliability'
  : S.catalog.find(p => p.id === s.provider)?.models.find(m => m.id === s.model)?.label ?? s.model;

function newChat() { chat = { id: uid(), title: 'New chat', updated: Date.now(), messages: [] }; renderAll(); return chat; }

// ---------- Rendering ----------
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderMsgs(); }); };
function renderMsgs() {
  const near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
  msgsEl.innerHTML = chat.messages.length ? chat.messages.map(m => m.role === 'user' ? `<div class="u">${esc(m.content)}</div>`
    : `<div class="a">${m.content ? md(m.content) : '<span class="dots">●●●</span>'}${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ''}</div>`).join('')
    : '<div class="empty">What can I help with?</div>';
  if (near) msgsEl.scrollTop = msgsEl.scrollHeight;
}
function renderAll() { $('#pickerLabel').textContent = S.mode === 'remote' ? `Server · ${label(S.strategy)}` : label(S.strategy); renderMsgs(); sendBtn.textContent = busy ? '■' : '↑'; sendBtn.classList.toggle('stop', busy); }

// ---------- Sending ----------
async function send() {
  if (busy) { ctl?.abort(); return; }
  const text = input.value.trim(); if (!text) return;
  haptic('light'); input.value = ''; input.style.height = 'auto';
  if (!chats.includes(chat)) chats.unshift(chat);
  const ctx: Msg[] = [...(S.system ? [{ role: 'system' as const, content: S.system }] : []), ...chat.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: text }];
  chat.messages.push({ role: 'user', content: text });
  if (chat.title === 'New chat') chat.title = text.slice(0, 40);
  const a = { role: 'assistant' as const, content: '', meta: undefined as string | undefined }; chat.messages.push(a);
  busy = true; ctl = new AbortController(); renderAll(); msgsEl.scrollTop = msgsEl.scrollHeight;
  try {
    for await (const ev of router.chat(ctx, S.strategy, ctl.signal)) { if (ev.meta) a.meta = ev.meta; if (ev.delta) { a.content += ev.delta; schedule(); } }
    haptic('success');
  } catch (e: any) { a.content += `${a.content ? '\n\n' : ''}⚠️ ${e?.message ?? e}`; }
  busy = false; ctl = null; chat.updated = Date.now(); renderAll(); persistChats(); persistSecrets();
}

// ---------- Sheets ----------
function openSheet(html: string) { const top = sheet.querySelector('.panel')?.scrollTop ?? 0; sheet.innerHTML = `<div class="panel">${html}</div>`; sheet.hidden = false; sheet.querySelector('.panel')!.scrollTop = top; }
const closeSheet = () => { sheet.hidden = true; sheet.innerHTML = ''; };
const val = (id: string) => (sheet.querySelector('#' + id) as HTMLInputElement | null)?.value.trim() ?? '';
const note = (t: string) => { const n = sheet.querySelector('#note'); if (n) n.textContent = t; };

function pickerSheet() {
  const on = (s: Strategy) => JSON.stringify(s) === JSON.stringify(S.strategy) ? ' on' : '';
  const strat = (['failover', 'fastest', 'reliable'] as Strategy[]).map(s => `<button class="opt${on(s)}" data-act="pick" data-s="${s}">${label(s)}<br><small>${s === 'failover' ? 'Try providers in order, rotate keys' : s === 'fastest' ? 'Lowest time-to-first-token' : 'Best recent success rate'}</small></button>`).join('');
  const models = S.catalog.filter(p => X.keys.some(k => k.provider === p.id)).map(p => `<h4>${esc(p.name)}</h4>` + p.models.map(m => `<button class="opt${on({ provider: p.id, model: m.id })}" data-act="pick" data-p="${esc(p.id)}" data-m="${esc(m.id)}">${esc(m.label)}</button>`).join('')).join('');
  openSheet(`<h4>Routing strategy</h4>${strat}${models || '<p class="note">Add a provider key in Settings to pick specific models.</p>'}`);
}

function status(k: KeyEntry) { return k.cooldownUntil > Date.now() ? ['cooling down', 'bad'] : k.lastError ? ['error', 'bad'] : k.ok ? ['healthy', ''] : ['untested', '']; }
function settingsSheet() {
  const keys = X.keys.map(k => { const p = S.catalog.find(x => x.id === k.provider), [st, cls] = status(k);
    return `<div class="row"><b>${esc(p?.name ?? k.provider)}</b><span class="pill ${cls}">••••${esc(k.key.slice(-4))} · ${st}</span><button data-act="test" data-id="${k.id}">Test</button><button data-act="del" data-id="${k.id}">${pendingDel === k.id ? 'Sure?' : '✕'}</button></div>`; }).join('');
  openSheet(`<h4>Routing</h4><div class="seg"><button data-act="mode" data-v="direct" class="${S.mode === 'direct' ? 'on' : ''}">On-device</button><button data-act="mode" data-v="remote" class="${S.mode === 'remote' ? 'on' : ''}">FreeLLMAPI server</button></div>
  ${S.mode === 'remote' ? `<input class="f" id="rUrl" placeholder="http://host:3001" value="${esc(S.remoteUrl)}"><input class="f" id="rKey" type="password" placeholder="fla_… unified key" value="${esc(X.remoteKey)}"><input class="f" id="rModel" placeholder="Model (default: auto)" value="${esc(S.remoteModel)}"><button class="btn main" data-act="saveRemote">Save server</button>` : `
  <h4>Provider keys</h4>${keys || '<p class="note">No keys yet.</p>'}
  <select class="f" id="kProv">${S.catalog.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}<option value="custom">Custom endpoint…</option></select>
  <input class="f" id="kCName" placeholder="Custom: name"><input class="f" id="kCUrl" placeholder="Custom: base URL (…/v1)"><input class="f" id="kCModel" placeholder="Custom: model id">
  <input class="f" id="kKey" type="password" placeholder="API key"><button class="btn main" data-act="addKey">Add key</button><button class="btn" data-act="sync">Sync models</button>`}
  <h4>System prompt</h4><textarea class="f" id="sys" rows="2" placeholder="Optional">${esc(S.system)}</textarea><button class="btn" data-act="saveSys">Save</button>
  <h4>Backup</h4><input class="f" id="pass" type="password" placeholder="Passphrase (required to include/restore keys)">
  <button class="btn" data-act="export">Export</button><button class="btn" data-act="import">Import…</button><input id="file" type="file" accept="application/json,.json" hidden>
  <p class="note" id="note"></p>`);
}

async function act(a: string, el: HTMLElement) {
  const d = el.dataset;
  switch (a) {
    case 'pick': S.strategy = d.p ? { provider: d.p, model: d.m! } : (d.s as Strategy); saveAll(); renderAll(); closeSheet(); return;
    case 'mode': S.mode = d.v as Settings['mode']; saveAll(); renderAll(); return settingsSheet();
    case 'saveRemote': S.remoteUrl = val('rUrl'); S.remoteModel = val('rModel') || 'auto'; X.remoteKey = val('rKey'); saveAll(); return note('Saved.');
    case 'saveSys': S.system = (sheet.querySelector('#sys') as HTMLTextAreaElement).value; saveAll(); return note('Saved.');
    case 'addKey': {
      const key = val('kKey'); if (!key) return note('Enter a key.');
      let provider = val('kProv');
      if (provider === 'custom') {
        const url = val('kCUrl'), model = val('kCModel'); if (!/^https?:\/\//.test(url) || !model) return note('Custom needs a base URL and model id.');
        provider = 'custom-' + uid().slice(0, 6);
        S.catalog.push({ id: provider, name: val('kCName') || 'Custom', baseUrl: url, models: [{ id: model, label: model }] });
      }
      X.keys.push({ id: uid(), provider, key, cooldownUntil: 0, ok: 0, fail: 0, lastUsed: 0 }); saveAll(); return settingsSheet();
    }
    case 'del': if (pendingDel !== d.id) { pendingDel = d.id!; return settingsSheet(); } pendingDel = ''; X.keys = X.keys.filter(k => k.id !== d.id); saveAll(); return settingsSheet();
    case 'test': { note('Testing…'); const k = X.keys.find(x => x.id === d.id)!; const r = await router.testKey(k); saveAll(); settingsSheet(); return note(r); }
    case 'sync': { note('Syncing…'); const n = await router.syncCatalog(); S.catalog = router.catalog; saveAll(); settingsSheet(); return note(`Updated ${n} provider(s).`); }
    case 'export': { const t = await exportBackup(chats, S, X, val('pass')); share('prismllm-backup.json', t); return note(val('pass') ? 'Exported with encrypted keys.' : 'Exported without keys (set a passphrase to include them).'); }
    case 'import': return (sheet.querySelector('#file') as HTMLInputElement).click();
  }
}

sheet.onclick = e => { const t = e.target as HTMLElement; if (t === sheet) return closeSheet(); const b = t.closest('[data-act]') as HTMLElement | null; if (b) { haptic('light'); act(b.dataset.act!, b); } };
sheet.onchange = async e => {
  const f = (e.target as HTMLInputElement); if (f.id !== 'file' || !f.files?.[0]) return;
  try {
    const r = await importBackup(await f.files[0].text(), val('pass'));
    chats = r.chats; S = { ...S, ...r.settings }; if (r.secrets) X = r.secrets; wire(); saveChats(chats); saveAll(); newChat(); settingsSheet(); note('Imported.');
  } catch (err: any) { note(err.message); }
};

function drawerView() {
  drawer.innerHTML = `<div class="panel"><button class="btn main" data-d="new">＋ New chat</button>${chats.map(c => `<div class="chat${c === chat ? ' on' : ''}"><span data-d="open" data-id="${c.id}">${esc(c.title)}</span><button data-d="del" data-id="${c.id}">${pendingDel === c.id ? 'Sure?' : '✕'}</button></div>`).join('')}</div>`;
  drawer.hidden = false;
}
drawer.onclick = e => {
  const t = e.target as HTMLElement; if (t === drawer) { drawer.hidden = true; return; }
  const b = t.closest('[data-d]') as HTMLElement | null; if (!b) return; haptic('light');
  const id = b.dataset.id!;
  if (b.dataset.d === 'new') { newChat(); drawer.hidden = true; }
  else if (b.dataset.d === 'open') { chat = chats.find(c => c.id === id)!; renderAll(); drawer.hidden = true; }
  else if (pendingDel !== id) { pendingDel = id; drawerView(); }
  else { pendingDel = ''; chats = chats.filter(c => c.id !== id); if (chat.id === id) newChat(); persistChats(); drawerView(); }
};

// ---------- Wiring, haptics, keyboard ----------
msgsEl.addEventListener('click', async e => {
  const b = (e.target as HTMLElement).closest('[data-copy]') as HTMLElement | null; if (!b) return;
  const text = b.closest('.code')!.querySelector('code')!.textContent ?? '';
  try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  haptic('light'); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200);
});
$('#menu').onclick = () => { haptic('light'); pendingDel = ''; drawerView(); };
$('#settings').onclick = () => { haptic('light'); settingsSheet(); };
$('#picker').onclick = () => { haptic('light'); pickerSheet(); };
sendBtn.onclick = send;
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });

// Keyboard avoidance: size the layout to the visual viewport so the input bar rides above the keyboard.
const vv = window.visualViewport;
const fit = () => { const h = vv?.height ?? innerHeight; document.documentElement.style.setProperty('--vh', h + 'px'); document.body.classList.toggle('kb', innerHeight - h > 120); window.scrollTo(0, 0); msgsEl.scrollTop = msgsEl.scrollHeight; };
vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', () => window.scrollTo(0, 0));

(async () => { const st = await loadAll(); chats = st.chats; S = st.settings; X = st.secrets; wire(); chat = chats[0] ?? newChat(); renderAll(); })();
