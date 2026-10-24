import assert from 'node:assert/strict';
import { modelHistoryContent } from '../apps/mobile/src/modelHistory.ts';

const history = { role: 'assistant', speech_ja: 'ここにいるよ。', display_zh: '我在这里。',
  displayed: true, status: 'played', played_samples: 48000, total_samples: 48000 };
const lines = modelHistoryContent(history).split('\n').map(line => JSON.parse(line));
assert.deepEqual(lines.map(line => line.type), ['speech', 'translation']);
assert.equal(lines[0].key, lines[1].key);
assert.equal(lines[0].speech_ja, history.speech_ja);
assert.equal(lines[1].display_zh, history.display_zh);
assert.ok(lines.every(line => !('played_samples' in line) && !('status' in line) && !('displayed' in line)));
assert.equal(modelHistoryContent({ role: 'user', text: '你好' }), '你好');
assert.equal(modelHistoryContent({ role: 'assistant', speech_ja: history.speech_ja }).split('\n').length, 1);
console.log('Mobile model history protocol regression passed.');
