// Browser test of the cloud and AI screens, with a fake OpenAI-compatible AI.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'test-results');
const REAL_RCLONE = [path.join(ROOT, 'data/bin/rclone'), '/usr/bin/rclone'].find((p) => fs.existsSync(p));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    const p = path.join(cache, dir, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const chrome = findChrome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-ui2-'));
const CLIPS = path.join(TMP, 'clips');
const NAS = path.join(TMP, 'nas');
const PORT = 7000 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;
let fakeAi;
let browser;
let page;
const errors = [];

function makeClip(file, seconds = 6, burstAt = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)+if(between(t,${burstAt},${burstAt + 0.6}),0.9*(random(0)-0.5),0)':s=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file]);
}

function answerFor(schema) {
  const req = schema.required || [];
  if (req.includes('title')) return { title: 'Le combo de la mort', description: 'Il était à 1 PV…', hashtags: ['tekken8', 'fgc', 'clutch'] };
  if (req.includes('hooks')) return { hooks: ['1 PV restant 😱', 'Regarde jusqu’au bout'] };
  if (req.includes('ok')) return { ok: true, message: 'Prêt à monter tes clips !' };
  if (req.includes('explanation')) {
    return { explanation: 'Passé en mise en page combat.', format: 'vertical', fit: 'fight', fps: 60, transition: 'none', transitionDuration: 0.3, segments: [{ clipId: 1, start: 0, end: 3 }], texts: [] };
  }
  return {};
}

before(async () => {
  if (!chrome) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  makeClip(path.join(CLIPS, 'TEKKEN™8 2026-10-01 20-00-00.mp4'));
  makeClip(path.join(NAS, 'Street Fighter 6', 'SF6 2026-10-03 18-00-00.mp4'));
  makeClip(path.join(NAS, 'Street Fighter 6', 'SF6 2026-10-04 18-00-00.mp4'));

  fakeAi = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mini' }, { id: 'maxi' }] }));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const schema = body.response_format.json_schema.schema;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answerFor(schema)) } }] }));
  });
  await new Promise((r) => fakeAi.listen(0, r));

  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS, ...(REAL_RCLONE ? { CLIPFORGE_RCLONE: REAL_RCLONE } : {}) },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    const clips = await fetch(`${BASE}/api/clips`).then((r) => r.json(), () => []);
    if (clips.length === 1) break;
    if (i > 300) throw new Error('server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: chrome });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|net::/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});

after(async () => {
  await browser?.close();
  server?.kill();
  fakeAi?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const t = (name, opts, fn) => (fn
  ? test(name, { ...opts, skip: (!chrome && 'no Chromium found') || opts.skip }, fn)
  : test(name, { skip: !chrome && 'no Chromium found' }, opts));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

t('cloud page: add a NAS folder, sync, clips land in the library', { skip: !REAL_RCLONE && 'no rclone' }, async () => {
  await page.goto(BASE);
  await page.click('[data-nav="cloud"]');
  await page.waitForSelector('.empty:has-text("Aucune source")');
  await page.click('#cloud-new');
  await page.waitForSelector('.provider-grid');
  assert.ok(await page.locator('.provider').count() >= 7);
  await shot('20-cloud-providers');
  await page.click('[data-provider="local"]');
  await page.fill('#ca-form input[name="name"]', 'NAS salon');
  await page.fill('#ca-form input[name="path"]', NAS);
  await page.click('#ca-form button.primary');

  // right after adding, the picker opens: go into the folder, pick ONE of the two videos
  await page.waitForSelector('#cloud-browse[open] [data-folder]');
  await page.click('[data-folder="Street Fighter 6"]');
  await page.waitForSelector('[data-pick-video]');
  assert.equal(await page.locator('[data-pick-video]').count(), 2);
  assert.equal(await page.isDisabled('#cb-import'), true);
  await page.locator('[data-pick-video]').first().check();
  assert.match(await page.textContent('#cb-import'), /Importer 1 vidéo/);
  await shot('21-cloud-picker');
  await page.click('#cb-import');
  await page.waitForSelector('.video-row.imported', { timeout: 30_000 });
  await page.click('[data-close-cloud-browse]');
  await page.waitForSelector('.source:has-text("1 vidéo(s) importée(s)")');
  await shot('21-cloud-sources');

  await page.click('[data-nav="all"]');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, null, { timeout: 30_000 });
  await page.waitForSelector('#games .game-name:has-text("SF6")');

  // removing the source deletes its imported video from the library
  await page.click('[data-nav="cloud"]');
  await page.click('.source [data-del-source]');
  await page.waitForSelector('.toast:has-text("1 vidéo(s) supprimée(s)")');
  await page.click('[data-nav="all"]');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, null, { timeout: 30_000 });
  assert.ok(fs.existsSync(path.join(NAS, 'Street Fighter 6', 'SF6 2026-10-03 18-00-00.mp4')), 'original kept');
});

t('AI page: add a provider, list models, test it', async () => {
  await page.click('[data-nav="ai"]');
  await page.waitForSelector('#ai-add');
  await page.selectOption('#ai-add select[name="preset"]', 'custom');
  assert.equal(await page.isVisible('#ai-add [data-for="url"]'), true);
  await page.fill('#ai-add input[name="baseUrl"]', `http://127.0.0.1:${fakeAi.address().port}/v1`);
  await page.fill('#ai-add input[name="apiKey"]', 'cle-test');
  await page.fill('#ai-add input[name="model"]', 'mini');
  await page.click('#ai-add button.primary');
  await page.waitForSelector('.source[data-ai]');
  await page.click('[data-load-models]');
  await page.waitForFunction(() => document.querySelectorAll('datalist option').length === 2);
  await page.click('[data-test-ai]');
  await page.waitForSelector('[data-test-result]:has-text("Prêt à monter")');
  await shot('22-ai-settings');
});

t('publish dialog: the AI writes the caption', async () => {
  const clip = (await (await fetch(`${BASE}/api/clips`)).json()).find((c) => c.game === 'TEKKEN™8');
  const job = await (await fetch(`${BASE}/api/clips/${clip.id}/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: 0, end: 4, format: 'vertical-blur' }),
  })).json();
  await page.click('[data-nav="exports"]');
  await page.waitForSelector(`[data-publish="${job.id}"]`, { timeout: 60_000 });
  await page.click(`[data-publish="${job.id}"]`);
  await page.click('[data-ptab="tiktok"]');
  await page.click('[data-ai-write]');
  await page.waitForFunction(() => document.querySelector('#man-caption').value.includes('#clutch'));
  assert.equal(await page.inputValue('#man-caption'), 'Il était à 1 PV… #tekken8 #fgc #clutch');
  await shot('23-publish-ai');
  await page.click('[data-close-publish]');
});

t('montage: AI hooks and the assistant with undo', async () => {
  await page.click('[data-nav="all"]');
  await page.waitForSelector('.card');
  await page.locator('.card').first().click({ modifiers: ['Shift'] });
  // "Assistant IA" from the selection: a montage of exactly these videos, assistant open
  await page.click('#selbar-assistant');
  await page.waitForSelector('#assistant[open] .pool-item');
  assert.equal(await page.locator('.pool-item').count(), 1);
  assert.match(await page.textContent('#as-pool'), /uniquement avec cette vidéo/);
  await page.click('[data-close-assistant]');
  await page.waitForSelector('#montage:not([hidden]) .seq-item');

  await page.click('.tab[data-tab="texts"]');
  await page.click('#mt-hooks');
  await page.waitForSelector('[data-hook]');
  await page.locator('[data-hook]').first().click();
  await page.waitForSelector('.ov-text:has-text("1 PV restant")');

  await page.click('#mt-assistant');
  await page.locator('[data-example]').nth(1).click();
  await page.click('#as-run');
  await page.waitForSelector('#as-result:has-text("mise en page combat")');
  await shot('24-assistant');
  assert.equal(await page.isVisible('#as-undo'), true);
  await page.click('#as-undo');
  await page.waitForSelector('#as-result:has-text("annulée")');
  await page.click('[data-close-assistant]');
  await page.click('[data-close-montage]');
});

t('no browser errors', () => {
  assert.deepEqual(errors, []);
});
