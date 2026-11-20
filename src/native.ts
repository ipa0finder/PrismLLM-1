// Bridge to the Swift shell (WKWebView). Every function degrades to a browser fallback for dev.
import type { Transport } from './router';

const wk = (window as any).webkit?.messageHandlers?.native;
export const hasNative = !!wk;
const call = (m: object): Promise<any> => wk.postMessage(m);

export const haptic = (style: 'light' | 'medium' | 'success' = 'light') => {
  if (hasNative) call({ type: 'haptic', style }); else navigator.vibrate?.(8);
};
export const secretGet = async (k: string): Promise<string | null> => hasNative ? call({ type: 'kv.get', k }) : localStorage.getItem('s:' + k);
export const secretSet = async (k: string, v: string) => { hasNative ? await call({ type: 'kv.set', k, v }) : localStorage.setItem('s:' + k, v); };
export const docGet = async (name: string): Promise<string | null> => hasNative ? call({ type: 'fs.read', name }) : localStorage.getItem('d:' + name);
export const docSet = async (name: string, v: string) => { hasNative ? await call({ type: 'fs.write', name, v }) : localStorage.setItem('d:' + name, v); };
export const share = (name: string, text: string) => {
  if (hasNative) return call({ type: 'share', name, text });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
};

// Streaming fetch via URLSession (no CORS). Swift pushes base64 chunks into window.__nf.
type Sink = { head: (s: number, h: Record<string, string>) => void; chunk: (b: Uint8Array) => void; end: (e?: string) => void };
const sinks = new Map<string, Sink>();
(window as any).__nf = (id: string, kind: string, b64: string) => {
  const s = sinks.get(id); if (!s) return;
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (kind === 'head') { const j = JSON.parse(new TextDecoder().decode(bin)); s.head(j.status, j.headers); }
  else if (kind === 'chunk') s.chunk(bin);
  else { s.end(bin.length ? new TextDecoder().decode(bin) : undefined); sinks.delete(id); }
};

const nativeTransport: Transport = (url, init, signal) => new Promise((resolve, reject) => {
  const id = crypto.randomUUID(); const q: string[] = []; const dec = new TextDecoder();
  let done = false, err: string | undefined, wake: (() => void) | undefined;
  const poke = () => { wake?.(); wake = undefined; };
  sinks.set(id, {
    head: (status, headers) => resolve({ status, headers, body: (async function* () {
      for (;;) {
        if (q.length) { yield q.shift()!; continue; }
        if (done) { if (err) throw new Error(err); return; }
        await new Promise<void>(r => (wake = r));
      }
    })() }),
    chunk: b => { q.push(dec.decode(b, { stream: true })); poke(); },
    end: e => { done = true; err = e; poke(); if (e) reject(new Error(e)); },
  });
  signal?.addEventListener('abort', () => { call({ type: 'abort', id }); done = true; err = undefined; poke(); });
  call({ type: 'fetch', id, url, ...init });
});

const webTransport: Transport = async (url, init, signal) => {
  const r = await fetch(url, { ...init, signal }); const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { status: r.status, headers, body: (async function* () {
    if (!r.body) return; const rd = r.body.getReader(), d = new TextDecoder();
    for (;;) { const { done, value } = await rd.read(); if (done) return; yield d.decode(value, { stream: true }); }
  })() };
};
export const transport: Transport = hasNative ? nativeTransport : webTransport;
