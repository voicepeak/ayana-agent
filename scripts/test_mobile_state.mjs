import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reduceEvent, speechTextReady, replyWaitLabel } from '../apps/mobile/src/state.ts';
import { modelHistoryContent } from '../apps/mobile/src/modelHistory.ts';
import { splitGraphemes } from '../apps/mobile/src/typography.ts';

test('progressive captions keep emoji families and combining accents intact', () => {
  assert.deepEqual(splitGraphemes('一家👨‍👩‍👧‍👦 A\u0301 café 🇨🇳👍🏽'), ['一', '家', '👨‍👩‍👧‍👦', ' ', 'A\u0301', ' ', 'c', 'a', 'f', 'é', ' ', '🇨🇳', '👍🏽']);
});

const event = (type, value = {}) => ({ protocol_version: 1, type, ...value });
const speech = (id = 's1', generation = 2) => event('utterance.ready', { utterance_id: id, generation_id: generation, speech_ja: 'こんにちは。', turn_id: `t${generation}` });

test('replies stay between their user turns in the transcript', () => {
  let state = reduceEvent(initialState, event('user.message', { text: 'first', turn_id: 't2', generation_id: 2 }));
  state = reduceEvent(state, speech());
  state = reduceEvent(state, event('user.message', { text: 'second', turn_id: 't4', generation_id: 4 }));
  state = reduceEvent(state, speech('s2', 4));
  assert.deepEqual(state.history.map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
});
test('duplicate speech does not duplicate history', () => {
  const state = reduceEvent(reduceEvent(initialState, speech()), speech());
  assert.equal(state.history.length, 1);
});
test('translations update both live speech and persistent-history field names', () => {
  const state = reduceEvent(reduceEvent(initialState, speech()), event('subtitle.ready', { utterance_id: 's1', generation_id: 2, display_zh: '你好。' }));
  assert.equal(state.speeches[0].zh, '你好。');
  assert.equal(state.history[0].display_zh, '你好。');
});
test('cancelling preserves the displayed partial reply and rejects late packets', () => {
  let state = reduceEvent(initialState, speech());
  state = reduceEvent(state, event('playback.started', { utterance_id: 's1', generation_id: 2 }));
  state = reduceEvent(state, event('generation.cancelled', { cancelled_generation_id: 2, generation_id: 3 }));
  assert.equal(state.presented, 's1');
  assert.equal(state.speeches[0].state, 'partial');
  for (const type of ['utterance.ready', 'audio.ready', 'mobile.present', 'task.state', 'error']) {
    assert.equal(reduceEvent(state, event(type, { generation_id: 2, utterance_id: 'late', state: 'thinking' })), state);
  }
});
test('text presentation advances each generated speech exactly once', () => {
  let state = reduceEvent(initialState, speech());
  state = reduceEvent(state, event('mobile.present', { utterance_id: 's1', generation_id: 2 }));
  assert.equal(state.speeches[0].state, 'played');
  assert.equal(reduceEvent(state, event('mobile.present', { utterance_id: 's1', generation_id: 2 })), state);
});
test('audio failure releases current playback so text fallback can run', () => {
  let state = reduceEvent(reduceEvent(initialState, speech()), event('playback.started', { utterance_id: 's1', generation_id: 2 }));
  state = reduceEvent(state, event('playback.error', { utterance_id: 's1', generation_id: 2 }));
  assert.equal(state.current, undefined);
  assert.equal(state.speeches[0].state, 'generated');
});
test('zero-playback cancellation does not expose an unheard queued sentence', () => {
  const state = reduceEvent(reduceEvent(initialState, speech()), event('playback.cancelled', { utterance_id: 's1', generation_id: 2, played_samples: 0 }));
  assert.equal(state.speeches[0].state, 'cancelled');
});

test('captions wait for both languages and ignore premature native previews', () => {
  let state = reduceEvent(initialState, speech());
  assert.equal(speechTextReady(state.speeches[0], state.settings), false);
  state = reduceEvent(state, event('subtitle.ready', { utterance_id: 's1', generation_id: 2, display_zh: '你好。' }));
  assert.equal(speechTextReady(state.speeches[0], state.settings), true);
  state = reduceEvent(state, speech('s2'));
  assert.equal(reduceEvent(state, event('mobile.preview', { utterance_id: 's2', generation_id: 2 })), state);
  assert.equal(reduceEvent(state, event('mobile.preview', { utterance_id: 's1', generation_id: 2 })), state);
  assert.equal(state.speeches[0].state, 'generated');
  assert.equal(state.presented, undefined);
  state = reduceEvent(state, event('playback.started', { utterance_id: 's1', generation_id: 2, total_samples: 32000 }));
  assert.equal(state.current, 's1');
  assert.equal(state.presented, 's1');
  state = reduceEvent(state, event('playback.ended', { utterance_id: 's1', generation_id: 2, played_samples: 32000, total_samples: 32000 }));
  assert.equal(state.current, undefined);
  assert.equal(state.presented, 's1');
});

test('cancelling an unheard preview keeps its text hidden', () => {
  let state = reduceEvent(reduceEvent(initialState, speech()), event('mobile.preview', { utterance_id: 's1', generation_id: 2 }));
  state = reduceEvent(state, event('generation.cancelled', { cancelled_generation_id: 2, generation_id: 3 }));
  assert.equal(state.speeches[0].state, 'cancelled');
  assert.equal(reduceEvent(state, event('mobile.preview', { utterance_id: 's1', generation_id: 2 })), state);
});

test('language readiness respects explicit subtitle preferences', () => {
  const state = reduceEvent(initialState, speech());
  assert.equal(speechTextReady(state.speeches[0], { companion_ui: { primary_language: 'ja', translation_language: 'none' } }), true);
  assert.equal(speechTextReady(state.speeches[0], { companion_ui: { primary_language: 'zh', translation_language: 'none' } }), false);
});

test('wait indicator remains after model finishes until the first audio starts', () => {
  let state = reduceEvent(initialState, event('task.state', { state: 'thinking', generation_id: 2 }));
  assert.equal(replyWaitLabel(state), '正在想…');
  state = reduceEvent(state, speech());
  state = reduceEvent(state, event('task.state', { state: 'idle', generation_id: 2 }));
  assert.equal(replyWaitLabel(state), '正在准备语音…');
  state = reduceEvent(state, event('playback.started', { utterance_id: 's1', generation_id: 2 }));
  assert.equal(replyWaitLabel(state), '');
});
test('changing character resets the active expression', () => {
  const state = reduceEvent({ ...initialState, presented: 'old' }, event('settings.ready', { settings: { character: 'ayana-su' } }));
  assert.equal(state.presented, undefined);
});
test('selecting a new topic clears live playback and stale history', () => {
  const state = reduceEvent({ ...initialState, current: 'old', history: [{ role: 'user', text: 'old' }] }, event('conversation.changed', { current: { conversation_id: 'new', title: 'new' }, conversations: [] }));
  assert.equal(state.current, undefined);
  assert.deepEqual(state.history, []);
});
test('old topic events cannot modify the new topic', () => {
  const state = { ...initialState, conversation: { conversation_id: 'new', title: 'new' } };
  assert.equal(reduceEvent(state, { ...speech(), conversation_id: 'old' }), state);
});
test('reactivation resets all previous account state', () => {
  const state = reduceEvent({ ...initialState, generation: 200, cancelledGeneration: 199, history: [{ text: 'secret' }] }, event('mobile.reset'));
  assert.deepEqual(state, initialState);
});
test('model context contains protocol examples without playback metadata', () => {
  const value = modelHistoryContent({ role: 'assistant', speech_ja: 'こんにちは。', display_zh: '你好。', status: 'partial', displayed: true, played_samples: 20 });
  const entries = value.split('\n').map(JSON.parse);
  assert.deepEqual(entries.map(item => item.type), ['speech', 'translation']);
  assert.ok(entries.every(item => !('status' in item) && !('played_samples' in item)));
});
