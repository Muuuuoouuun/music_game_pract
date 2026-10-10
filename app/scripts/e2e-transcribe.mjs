/**
 * End-to-end check of the 오디오 tab in a real (headless) Chromium:
 *   generate a WAV (C4 D4 E4 F4 G4, 120 BPM quarters, decaying sines, 44.1 kHz) →
 *   upload through the file input → run transcription → read the review card →
 *   add to the library → open play and confirm the 원곡 소리 toggle.
 *
 * Usage:  npx vite --port 5202 &  node scripts/e2e-transcribe.mjs
 * Env:    PLAYWRIGHT_PATH (default /opt/node22/lib/node_modules/playwright)
 *         CHROME_PATH     (default /opt/pw-browsers/chromium-1194/chrome-linux/chrome)
 *         E2E_URL         (default http://localhost:5202/)
 *         SHOTS           directory for screenshots (default ./e2e-shots)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL_ = process.env.E2E_URL ?? 'http://localhost:5202/';
const SHOTS = process.env.SHOTS ?? join(process.cwd(), 'e2e-shots');
mkdirSync(SHOTS, { recursive: true });

/** 16-bit PCM mono WAV of a note sequence; each note a decaying sine with a few partials. */
export function makeWav({ midis = [60, 62, 64, 65, 67], bpm = 120, sampleRate = 44100, leadMs = 300, tailMs = 700 } = {}) {
  const beat = 60 / bpm;
  const total = leadMs / 1000 + midis.length * beat + tailMs / 1000;
  const n = Math.round(total * sampleRate);
  const data = new Float32Array(n);
  midis.forEach((m, i) => {
    const f = 440 * 2 ** ((m - 69) / 12);
    const t0 = leadMs / 1000 + i * beat;
    const s0 = Math.round(t0 * sampleRate);
    const len = Math.round(beat * 0.95 * sampleRate);
    for (let k = 0; k < len && s0 + k < n; k++) {
      const t = k / sampleRate;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 3.2);
      const v = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * 2 * f * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f * t);
      data[s0 + k] += 0.45 * env * v;
    }
  });
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
  return buf;
}

async function main() {
  const wavPath = join(SHOTS, 'c-major-120.wav');
  writeFileSync(wavPath, makeWav());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const result = { ok: false };
  try {
    await page.goto(URL_ + '#import', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#srcAudio', { state: 'attached', timeout: 20000 });
    await page.click('.src-tabs [data-src="audio"]');
    await page.screenshot({ path: join(SHOTS, 'transcribe-1-before.png') });
    await page.setInputFiles('#srcAudio', wavPath);
    await page.waitForSelector('#wave:not([hidden])', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#btnConvert')?.textContent?.includes('변환 시작'), null, { timeout: 20000 });
    await page.screenshot({ path: join(SHOTS, 'transcribe-2-loaded.png') });
    const t0 = Date.now();
    await page.click('#btnConvert');
    // mid-run screenshot: wait for the infer step to be running
    await page.waitForFunction(() => document.querySelector('.step[data-i="2"]')?.dataset.s === 'run' || !document.querySelector('#review')?.hidden, null, { timeout: 180000 });
    await page.screenshot({ path: join(SHOTS, 'transcribe-3-during.png') });
    await page.waitForFunction(() => !document.querySelector('#review')?.hidden || document.querySelector('#pipeState')?.textContent === '실패', null, { timeout: 300000 });
    const elapsed = Date.now() - t0;
    const failed = await page.evaluate(() => document.querySelector('#pipeState')?.textContent === '실패');
    await page.screenshot({ path: join(SHOTS, 'transcribe-4-after.png'), fullPage: true });
    if (!(await page.evaluate(() => document.querySelector('#review')?.hidden))) {
      await page.locator('#review').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.locator('#review').screenshot({ path: join(SHOTS, 'transcribe-4b-review.png') });
    }
    if (failed) throw new Error('transcription failed: ' + (await page.evaluate(() => document.querySelector('#log')?.textContent)));
    const review = await page.evaluate(() => ({
      bpm: Number(document.querySelector('#aBpm').value),
      offsetMs: Number(document.querySelector('#aOffset').value),
      conf: document.querySelector('#rvConf').textContent,
      detect: [...document.querySelectorAll('#rvDetect div')].map((d) => d.textContent),
      fit: document.querySelector('#aFit').textContent,
      log: document.querySelector('#log').textContent,
      hands: document.querySelector('#rvHands').textContent,
      pipe: document.querySelector('#pipeState').textContent,
    }));
    Object.assign(result, { review, elapsedMs: elapsed });
    // Pull the chart's notes out of the strip preview via the library after adding.
    await page.fill('#impTitle', 'E2E 채보 테스트');
    await page.click('#impAdd');
    await page.waitForFunction(() => document.querySelector('#review')?.hidden, null, { timeout: 10000 });
    const stored = await page.evaluate(async () => {
      const idx = JSON.parse(localStorage.getItem('keystage.songs') || '[]');
      const e = idx.find((s) => s.title === 'E2E 채보 테스트');
      if (!e) return null;
      const chart = JSON.parse(localStorage.getItem('keystage.song.' + e.id));
      const ids = await new Promise((resolve) => {
        const req = indexedDB.open('keystage-audio', 1);
        req.onsuccess = () => {
          const tx = req.result.transaction('blobs', 'readonly');
          const r = tx.objectStore('blobs').getAllKeys();
          r.onsuccess = () => resolve(r.result.map(String));
          r.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      });
      return {
        id: e.id,
        midis: chart.notes.map((n) => n.midi),
        starts: chart.notes.map((n) => n.startMs),
        hands: chart.notes.map((n) => n.hand),
        bpm: chart.meta.bpm,
        audio: chart.audio,
        blobStored: ids.includes(chart.audio?.id),
        measures: chart.measures.length,
        kind: chart.meta.source.kind,
      };
    });
    result.stored = stored;
    // play screen: make the new song current (settings.songId) and reload so setSong runs
    await page.evaluate((id) => {
      const s = JSON.parse(localStorage.getItem('keystage.settings') || '{}');
      s.songId = id;
      localStorage.setItem('keystage.settings', JSON.stringify(s));
    }, stored.id);
    await page.goto(URL_ + '#play', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btnStart', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.click('#more summary');
    await page.waitForTimeout(200);
    const play = await page.evaluate(() => ({
      title: document.querySelector('#rdTitle')?.textContent,
      btRowHidden: document.querySelector('#btRow')?.hidden,
      backingChecked: document.querySelector('#optBacking')?.checked,
      gain: document.querySelector('#btGain')?.value,
      note: document.querySelector('#btNote')?.textContent,
      moreSum: document.querySelector('#moreSum')?.textContent,
    }));
    result.play = play;
    await page.screenshot({ path: join(SHOTS, 'transcribe-5-play-ready.png') });
    // start a run and check the recording is playing in sync
    await page.click('#btnStart');
    await page.waitForTimeout(600);
    const countin = await page.evaluate(() => ({ phase: document.querySelector('#scr-play')?.dataset.phase, backing: document.querySelector('#scr-play')?.dataset.backing }));
    await page.waitForTimeout(2200);
    const sync = await page.evaluate(() => ({ phase: document.querySelector('#scr-play')?.dataset.phase, backing: document.querySelector('#scr-play')?.dataset.backing }));
    result.play.countin = countin;
    result.play.afterStart = sync;
    // pause → recording stops; resume → it comes back after the 3-beat count
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    result.play.paused = await page.evaluate(() => ({ phase: document.querySelector('#scr-play')?.dataset.phase, backing: document.querySelector('#scr-play')?.dataset.backing }));
    await page.click('#pmResume');
    await page.waitForTimeout(2200);
    result.play.resumed = await page.evaluate(() => ({ phase: document.querySelector('#scr-play')?.dataset.phase, backing: document.querySelector('#scr-play')?.dataset.backing }));
    await page.screenshot({ path: join(SHOTS, 'transcribe-6-play-run.png') });
    result.ok = true;
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e);
  } finally {
    result.logs = logs.filter((l) => !/favicon|fonts\.g|ERR_|Download the React|net::/.test(l)).slice(-40);
    await browser.close();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
