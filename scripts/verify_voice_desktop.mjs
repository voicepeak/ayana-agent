/** Verify real GPT-SoVITS PCM, chat playback, cancellation and recovery. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root')] }));
const output = path.join(root, '.runtime/benchmarks/voice-desktop');
const profile = path.join(output, 'profile');
mkdirSync(path.join(profile, 'config'), { recursive: true });
const voice = JSON.parse(readFileSync(path.join(root, 'config/local.json'), 'utf8')).voice;
assert(voice?.engine_root, 'Configure the real voice before this check');
writeFileSync(path.join(profile, 'config/local.json'), JSON.stringify({ provider: 'local', voice, send_screenshot: false }));
const app = await _electron.launch({
  executablePath: option('--exe'), args: [`--user-data-dir=${profile}`],
  env: { ...process.env, AYANA_DATA_DIR: profile, AYANA_REPOSITORY_ROOT: '', AYANA_PYTHON: '' },
});
let events = [];
try {
  await app.firstWindow();
  const page = (await app.windows()).find(page => page.url().includes('window=chat'));
  assert(page);
  await page.waitForSelector('.composer');
  await page.waitForFunction(() => window.ayana.getState().then(state => state.connected));
  await page.waitForFunction(() => window.ayana.getState().then(state => state.events.some(event =>
    event.type === 'service.state' && event.service === 'tts' && event.state === 'ready'
    && event.engine === 'gpt-sovits-ayana' && event.semantic_tail_guard_frames === 4
    && event.semantic_tail_guard_long_frames === 6)), null, { timeout: 120000 });
  await page.evaluate(() => {
    window.__voiceCheck = [];
    window.ayana.onEvent(event => {
      if (['utterance.ready', 'audio.ready', 'generation.cancelled', 'error'].includes(event.type)
          || event.type.startsWith('playback.') && !Number.isFinite(event.seq)) window.__voiceCheck.push(event);
    });
  });
  const ask = async () => {
    await page.getByRole('textbox', { name: '输入问题' }).fill('你好');
    await page.getByRole('button', { name: '发送', exact: true }).click();
  };
  for (let turn = 0; turn < 3; turn++) {
    const start = await page.evaluate(() => window.__voiceCheck.length);
    await ask();
    if (turn === 1) {
      await page.waitForFunction(start => window.__voiceCheck.slice(start).some(event => event.type === 'playback.progress'), start, { timeout: 30000 });
      await page.evaluate(() => window.ayana.send({ type: 'generation.cancel' }));
      await page.waitForFunction(start => window.__voiceCheck.slice(start).some(event => event.type === 'playback.cancelled'), start);
      const partial = await page.evaluate(start => window.__voiceCheck.slice(start).find(event => event.type === 'playback.cancelled'), start);
      assert(partial.played_samples > 0 && partial.played_samples < partial.total_samples);
    } else {
      await page.waitForFunction(start => window.__voiceCheck.slice(start).filter(event => event.type === 'playback.ended').length === 2, start, { timeout: 60000 });
      const played = await page.evaluate(start => window.__voiceCheck.slice(start).filter(event => event.type === 'playback.ended'), start);
      for (const event of played) {
        assert.equal(event.played_samples, event.total_samples);
        assert(event.output_sample_rate > 0 && event.played_samples > 1000);
      }
    }
  }
  events = await page.evaluate(() => window.__voiceCheck);
  assert(!events.some(event => event.type === 'error'), JSON.stringify(events.filter(event => event.type === 'error')));
  let number = 0;
  for (const event of events.filter(event => event.type === 'audio.ready')) {
    assert.equal(event.engine, 'gpt-sovits-ayana');
    const float = Buffer.from(event.pcm_base64, 'base64');
    const count = float.length / 4;
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(event.sample_rate, 24); wav.writeUInt32LE(event.sample_rate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, float.readFloatLE(i * 4))) * 32767), 44 + i * 2);
    const sentence = events.find(item => item.type === 'utterance.ready' && item.utterance_id === event.utterance_id);
    event.speech_ja = sentence.speech_ja;
    event.wav = path.join(output, `sentence-${++number}.wav`);
    writeFileSync(event.wav, wav);
    delete event.pcm_base64;
  }
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(events, null, 2));
  console.log('PASS: packaged GPT-SoVITS tail guard; complete source samples on the real output device; mid-sentence cancellation; subsequent full playback.');
} finally {
  await app.close();
}
