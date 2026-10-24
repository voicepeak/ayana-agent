import type { HistoryRecord } from './types';

/** Reuse the reply protocol in history so the model cannot imitate playback records. */
export function modelHistoryContent(item: HistoryRecord): string {
  if (item.role === 'user') return item.text || '';
  const events: Record<string, unknown>[] = [{ type: 'speech', key: 's1', speech_ja: item.speech_ja }];
  if (item.display_zh) events.push({ type: 'translation', key: 's1', display_zh: item.display_zh });
  return events.map(event => JSON.stringify(event)).join('\n');
}
