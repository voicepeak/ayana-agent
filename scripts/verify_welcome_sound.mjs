/** Render the actual foley graph offline to check level, silence and headroom. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.join(root, 'apps/desktop')] }));
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const { _electron } = require(require.resolve('playwright', { paths: [option('--playwright-root') || root] }));
const folder = path.join(root, '.runtime/benchmarks', `welcome-sound-${Date.now()}`);
mkdirSync(folder, { recursive: true });
const entry = path.join(folder, 'main.cjs');
writeFileSync(entry, "const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({show:false}); w.loadURL('about:blank');});");
const bundle = await build({ entryPoints: [path.join(root, 'apps/desktop/renderer/welcomeSound.ts')], bundle: true, write: false, format: 'iife', globalName: 'WelcomeAudio' });
const app = await _electron.launch({ executablePath: path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'), args: [entry] });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState();
  await page.evaluate(source => { (0, eval)(source + '\n;globalThis.WelcomeAudio = WelcomeAudio;'); }, bundle.outputFiles[0].text);
  const result = await page.evaluate(async () => {
    let context;
    window.AudioContext = class {
      constructor() {
        context = new OfflineAudioContext(1, 48000 * 2, 48000);
        Object.defineProperty(context, 'state', { value: 'running' });
        return context;
      }
    };
    const measure = buffer => {
      const samples = buffer.getChannelData(0);
      let peak = 0, energy = 0;
      for (const sample of samples) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
      return { peak, rms: Math.sqrt(energy / samples.length) };
    };
    async function render(cue, volume = 1, muted = false) {
      const sound = new window.WelcomeAudio.WelcomeSound();
      sound.setVolume(volume, muted); sound.unlock();
      if (cue === 'transition') sound.transition('style', 1740); else sound.cue(cue);
      return measure(await context.startRendering());
    }
    // Previous click graph, including its 0.5 output and short exponential tail.
    const baseline = new OfflineAudioContext(1, 96000, 48000);
    const output = baseline.createGain(), limiter = baseline.createDynamicsCompressor();
    output.gain.value = .5; limiter.threshold.value = -14; limiter.ratio.value = 8;
    output.connect(limiter).connect(baseline.destination);
    const tone = baseline.createOscillator(), gain = baseline.createGain();
    tone.type = 'triangle'; tone.frequency.setValueAtTime(520, .005); tone.frequency.exponentialRampToValueAtTime(360, .095);
    gain.gain.setValueAtTime(0, .005); gain.gain.linearRampToValueAtTime(.1, .013); gain.gain.exponentialRampToValueAtTime(.0001, .095);
    tone.connect(gain).connect(output); tone.start(.005); tone.stop(.115);
    const old = measure(await baseline.startRendering());
    const cues = {};
    for (const cue of ['hover', 'press', 'focus', 'type', 'confirm', 'send', 'reply', 'record-start', 'record-stop', 'search', 'source', 'toggle-on', 'toggle-off', 'theme', 'ready', 'error', 'transition']) cues[cue] = await render(cue);
    return { old, cues, improvementDb: 20 * Math.log10(cues.press.rms / old.rms), zero: await render('send', 0), muted: await render('transition', 1, true), boosted: await render('transition', 1.5) };
  });
  assert(result.improvementDb > 6, 'The actual click waveform must be at least 6 dB stronger than the previous one');
  for (const [cue, signal] of Object.entries(result.cues)) {
    assert(signal.rms > 0, `${cue} must generate an audible waveform`);
    assert(signal.peak < .99, `${cue} must retain peak headroom`);
  }
  assert.equal(result.zero.peak, 0); assert.equal(result.muted.peak, 0);
  assert(result.boosted.peak < .99, '150% volume must retain peak headroom');
  writeFileSync(path.join(folder, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ improvementDb: result.improvementDb, cueCount: Object.keys(result.cues).length, maxPeak: Math.max(...Object.values(result.cues).map(value => value.peak)), boostedPeak: result.boosted.peak, mutedPeak: result.muted.peak, folder }, null, 2));
} finally { await app.close(); }
