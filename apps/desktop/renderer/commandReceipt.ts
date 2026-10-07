import { bridge } from './state';
import type { AyanaBridge } from './types';

/** IPC dispatch succeeds before a backend write. Await its matching receipt. */
export function commandReceipt(command: Record<string, unknown> & { type: string }, receipt: string,
  transport: AyanaBridge = bridge): Promise<void> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); off();
      if (error) reject(error); else resolve();
    };
    const off = transport.onEvent(event => {
      if (event.type === 'desktop.reset') finish(new Error('服务已重启，请核对后重试。'));
      if (event.request_id !== requestId) return;
      if (event.type === receipt) finish();
      if (event.type === 'error') finish(new Error(String(event.message || '操作未完成，请重试。')));
    });
    const timer = setTimeout(() => finish(new Error('尚未收到保存回执，请核对后重试。')), 20000);
    transport.send({ ...command, request_id: requestId })
      .then(result => { if (!result.ok) finish(new Error(result.error || '本地服务未连接。')); })
      .catch(error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
