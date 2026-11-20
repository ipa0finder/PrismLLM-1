import { DEFAULT_CATALOG, KeyEntry, Msg, ProviderDef, Strategy } from './router';
import { docGet, docSet, secretGet, secretSet } from './native';

export interface ChatMsg extends Msg { meta?: string }
export interface Chat { id: string; title: string; updated: number; messages: ChatMsg[] }
export interface Settings { mode: 'direct' | 'remote'; remoteUrl: string; remoteModel: string; strategy: Strategy; system: string; catalog: ProviderDef[] }
export interface Secrets { keys: KeyEntry[]; remoteKey: string }
export const uid = () => crypto.randomUUID();

const parse = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export async function loadAll() {
  const settings: Settings = { mode: 'direct', remoteUrl: '', remoteModel: 'auto', strategy: 'failover', system: '', catalog: structuredClone(DEFAULT_CATALOG), ...parse(await docGet('settings'), {}) };
  const secrets: Secrets = { keys: [], remoteKey: '', ...parse(await secretGet('secrets'), {}) };
  const chats: Chat[] = parse(await docGet('chats'), []);
  return { settings, secrets, chats };
}
export const saveChats = (c: Chat[]) => docSet('chats', JSON.stringify(c));
export const saveSettings = (s: Settings) => docSet('settings', JSON.stringify(s));
export const saveSecrets = (x: Secrets) => secretSet('secrets', JSON.stringify(x));

// --- Backup: chats + settings in clear JSON; keys only when a passphrase is given (AES-GCM, PBKDF2) ---
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function derive(pass: string, salt: Uint8Array) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 200000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function exportBackup(chats: Chat[], settings: Settings, secrets: Secrets, pass: string) {
  const out: any = { app: 'PrismLLM', version: 1, chats, settings };
  if (pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await derive(pass, salt), new TextEncoder().encode(JSON.stringify(secrets)) as BufferSource);
    out.secrets = { salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) };
  }
  return JSON.stringify(out, null, 1);
}
export async function importBackup(text: string, pass: string) {
  const j = JSON.parse(text); if (j.app !== 'PrismLLM') throw new Error('Not a PrismLLM backup.');
  let secrets: Secrets | undefined;
  if (j.secrets) {
    if (!pass) throw new Error('This backup has keys: enter its passphrase first.');
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.secrets.iv) as BufferSource }, await derive(pass, unb64(j.secrets.salt)), unb64(j.secrets.data) as BufferSource);
      secrets = JSON.parse(new TextDecoder().decode(pt));
    } catch { throw new Error('Wrong passphrase.'); }
  }
  return { chats: j.chats as Chat[], settings: j.settings as Settings, secrets };
}
