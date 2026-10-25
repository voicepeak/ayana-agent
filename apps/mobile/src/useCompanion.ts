import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { NativeCompanion, nativeAndroid, nativeIOS } from './companionNative';
import type { CompanionStatus } from './companionNative';

export function useCompanion(onCancel: () => void, onError: (error: unknown) => void) {
  const [status, setStatus] = useState<CompanionStatus>({ overlay: nativeAndroid, pip: nativeIOS, active: false, collapsed: false, permission: false });
  const [preview, setPreview] = useState(false);
  const [working, setWorking] = useState(false);
  const handlers = useRef({ onCancel, onError }); handlers.current = { onCancel, onError };
  const operation = useRef(false);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    const state = NativeCompanion.addListener('state', value => { if (!disposed) setStatus(value); });
    const action = NativeCompanion.addListener('action', event => { if (event.action === 'cancel') handlers.current.onCancel(); });
    void NativeCompanion.status().then(value => { if (!disposed) setStatus(value); }).catch(error => handlers.current.onError(error));
    return () => { disposed = true; void state.then(handle => handle.remove()); void action.then(handle => handle.remove()); };
  }, []);
  const start = useCallback(async () => {
    if (operation.current) return;
    operation.current = true; setWorking(true);
    try {
      if (!Capacitor.isNativePlatform()) { setPreview(true); return; }
      if (nativeAndroid) {
        const permission = await NativeCompanion.requestPermission();
        if (!permission.granted) throw new Error('未获得悬浮窗权限，你可以稍后在系统设置中开启。');
      }
      await NativeCompanion.start();
      setStatus(await NativeCompanion.status());
    } catch (error) { handlers.current.onError(error); }
    finally { operation.current = false; setWorking(false); }
  }, []);
  const stop = useCallback(async (restore: boolean) => {
    if (!restore) handlers.current.onCancel();
    setPreview(false);
    if (!Capacitor.isNativePlatform()) { setStatus(value => ({ ...value, collapsed: false })); return; }
    try { await NativeCompanion.stop({ restore }); setStatus(await NativeCompanion.status()); }
    catch (error) { handlers.current.onError(error); }
  }, []);
  const collapse = useCallback(async (collapsed: boolean) => {
    if (!nativeAndroid) { setStatus(value => ({ ...value, collapsed })); return; }
    try { await NativeCompanion.collapse({ collapsed }); setStatus(await NativeCompanion.status()); }
    catch (error) { handlers.current.onError(error); }
  }, []);
  const floating = preview || (nativeAndroid && status.active);
  useEffect(() => {
    document.documentElement.classList.toggle('companion-overlay-active', floating);
    document.documentElement.classList.toggle('companion-overlay-preview', preview);
    return () => { document.documentElement.classList.remove('companion-overlay-active', 'companion-overlay-preview'); };
  }, [floating, preview]);
  return { status, preview, floating, working, start, stop, collapse };
}
