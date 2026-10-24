import { Capacitor } from '@capacitor/core';
import { credentials, readLocal, writeLocal } from './storage';
import { characterBootstrap, assetUrl } from './character';
import type { Bootstrap } from './types';
import { identifier } from './identifier';

export const NATIVE = Capacitor.isNativePlatform();
type Session = { gateway: string; user_id: string; access_token: string; refresh_token: string; expires_at: number; config: Record<string, unknown> };
let session: Session | undefined;
let refreshing: Promise<Session> | undefined;
const BUILD_GATEWAY = (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_AYANA_GATEWAY_URL || '';

export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}
export function normalizeServer(raw: string) {
  const url = new URL(raw);
  const parts = url.hostname.split('.').map(Number);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
      && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)));
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('网关必须使用 HTTPS；本地试用允许同一可信 Wi-Fi 的内网 HTTP 地址');
  }
  return url.origin;
}
async function request<T>(gateway: string, path: string, body: unknown, token = ''): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${gateway}${path}`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), credentials: 'omit' });
  } catch { throw new ApiError('无法连接网关，请确认电脑服务已启动、手机与电脑在同一 Wi-Fi'); }
  if (!response.ok) throw new ApiError(response.status === 401 ? '激活凭据失效，请重新输入激活码' : `网关请求失败（${response.status}）`, response.status);
  return response.json() as Promise<T>;
}
export function serverLabel() { return session?.gateway || '尚未激活'; }
export function sessionOwner() { return session?.user_id || 'unpaired'; }
export function storedServer() { return ''; }
export async function sessionState() {
  try {
    const saved = await credentials.get();
    session = saved ? JSON.parse(saved) as Session : undefined;
    if (session) session.gateway = normalizeServer(session.gateway);
  } catch { session = undefined; throw new Error('无法读取手机安全凭据，请重新激活'); }
  return { paired: Boolean(session), available: true, native: NATIVE, android_apk: false };
}
export async function pair(input: string, _server?: string) {
  let gateway = BUILD_GATEWAY || (!NATIVE ? window.location.origin : '');
  let key = input.trim();
  if (key.startsWith('ayana1.')) {
    try {
      const raw = key.slice(7).replace(/-/g, '+').replace(/_/g, '/');
      const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
      gateway = value.url;
      key = value.key;
    } catch { throw new Error('激活码格式不正确，请完整复制电脑生成的激活码'); }
  }
  if (!gateway) throw new Error('请粘贴电脑生成的完整 ayana1 激活码');
  gateway = normalizeServer(gateway);
  let device = await readLocal<string>('device-id');
  if (!device) { device = identifier(); await writeLocal('device-id', device); }
  const result = await request<Omit<Session, 'gateway'>>(gateway, '/v1/activate', { key, device_id: device });
  session = { ...result, gateway };
  await credentials.set(JSON.stringify(session));
  return { ok: true };
}
export async function access() {
  if (!session) throw new ApiError('请先激活', 401);
  if (session.expires_at > Date.now() / 1000 + 60) return session;
  if (!refreshing) {
    const current = session;
    refreshing = request<Omit<Session, 'gateway'>>(current.gateway, '/v1/refresh', { refresh_token: current.refresh_token })
      .then(async result => { session = { ...result, gateway: current.gateway }; await credentials.set(JSON.stringify(session)); return session; })
      .finally(() => { refreshing = undefined; });
  }
  return refreshing;
}
export async function logout() {
  const current = session;
  await credentials.clear();
  session = undefined;
  if (current) await request(current.gateway, '/v1/logout', {}, current.access_token).catch(() => {});
  return { ok: true };
}
export async function bootstrap(): Promise<Bootstrap> { return characterBootstrap(); }
export async function fetchAsset(assetId: string) {
  const response = await fetch(assetUrl(assetId));
  if (!response.ok) throw new Error('手机本地角色资源缺失');
  return response.blob();
}
