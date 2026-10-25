import { Capacitor, registerPlugin } from '@capacitor/core';

const vault = registerPlugin<{ get(): Promise<{ value?: string }>; set(options: { value: string }): Promise<void>; clear(): Promise<void> }>('AyanaVault');
let db: Promise<IDBDatabase> | undefined;
function database() {
  return db ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ayana-independent-mobile', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => {
      const handle = request.result;
      handle.onversionchange = () => { handle.close(); db = undefined; };
      resolve(handle);
    };
    request.onerror = () => reject(new Error('无法打开手机本地数据库'));
    request.onblocked = () => reject(new Error('请关闭其他 Ayana 页面后重试'));
  }).catch(error => { db = undefined; throw error; });
}
export async function readLocal<T>(key: string): Promise<T | undefined> {
  const handle = await database();
  return new Promise((resolve, reject) => {
    const request = handle.transaction('state').objectStore('state').get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
export async function writeLocal(key: string, value: unknown): Promise<void> {
  const handle = await database();
  return new Promise((resolve, reject) => {
    const transaction = handle.transaction('state', 'readwrite');
    transaction.objectStore('state').put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('本地保存中断'));
  });
}
export const credentials = {
  async get() {
    return Capacitor.isNativePlatform() ? (await vault.get()).value || '' : (await readLocal<string>('web-session')) || '';
  },
  async set(value: string) {
    if (Capacitor.isNativePlatform()) await vault.set({ value });
    else await writeLocal('web-session', value);
  },
  async clear() {
    if (Capacitor.isNativePlatform()) await vault.clear();
    else await writeLocal('web-session', '');
  },
};
