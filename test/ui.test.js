// Browser test of the full user journey. Skipped when no Chromium is available
// (set CHROME_PATH, or install one with `npx playwright-core install chromium`).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'test-results');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    for (const bin of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const p = path.join(cache, dir, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const chrome = findChrome();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-ui-'));
const CLIPS = path.join(TMP, 'clips');
const PORT = 4900 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;
let browser;
let page;
const errors = [];

function makeClip(file, { size = '1280x720', seconds = 6, src = 'testsrc2', audio } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=${size}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', audio || `sine=frequency=330:duration=${seconds}`, '-c:a', 'aac', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', file]);
}

const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

before(async () => {
  if (!chrome) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // a loud burst at 5 s so highlight detection has something to find
  makeClip(path.join(CLIPS, 'Valorant 2026-10-15 21-04-33.mp4'), {
    seconds: 8, audio: "aevalsrc='0.03*sin(2*PI*300*t)+if(between(t,5,5.6),0.9*(random(0)-0.5),0)':s=48000:d=8",
  });
  makeClip(path.join(CLIPS, 'Rocket League 10_14_2026 9_15_02 PM.mp4'), { src: 'testsrc' });
  makeClip(path.join(CLIPS, 'Fortnite 2026-10-12 20-00-00.mp4'), { src: 'smptebars', seconds: 5 });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
    '-c:a', 'libmp3lame', path.join(TMP, 'chill beat.mp3')]);

  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    const games = await fetch(`${BASE}/api/games`).then((r) => r.json(), () => []);
    if (games.length === 3) break;
    if (i > 300) throw new Error('server did not finish scanning the fixtures within 60 s');
    await new Promise((r) => setTimeout(r, 200));
  }

  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: chrome });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_ABORTED|net::/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: !chrome && 'no Chromium found' }, fn);

t('library shows clips grouped by game', async () => {
  await page.goto(BASE);
  await page.waitForSelector('.card');
  assert.equal(await page.locator('.card').count(), 3);
  assert.deepEqual(await page.locator('#games .game-name').allTextContents(), ['Valorant', 'Rocket League', 'Fortnite']);
  await shot('1-library');
});

t('clip editor: trim with keyboard, export, add to a new montage', async () => {
  await page.locator('.card').first().click();
  await page.waitForFunction(() => document.querySelector('#ed-video').readyState >= 1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('o');
  assert.equal(await page.textContent('#ed-sel-range'), '0:02.0 → 0:07.0');

  await page.locator('.format').nth(2).click();
  assert.equal(await page.isVisible('#ed-mask'), true);
  await page.fill('#ed-title', 'Ace en ranked');
  await shot('2-clip-editor');
  await page.click('#ed-export');
  await page.waitForSelector('.toast');

  await page.waitForSelector('#ed-add-montage select');
  await page.click('#ed-add-montage button');
  await page.waitForSelector('.toast:has-text("Ajouté à")');
  await page.click('[data-close-editor]');
});

t('multi-select clips and build a montage with text, style and music', async () => {
  await page.click('[data-nav="all"]');
  await page.waitForSelector('.card');
  const cards = page.locator('.card');
  await cards.nth(0).hover();
  await cards.nth(0).locator('.pick').click();
  await cards.nth(1).click({ modifiers: ['Shift'] });
  assert.equal(await page.textContent('#selbar-count'), '2 clips sélectionnés');
  await page.click('#selbar-create');

  await page.waitForSelector('#montage:not([hidden]) .seq-item');
  assert.equal(await page.locator('.seq-item').count(), 2);

  // add a third clip from the picker
  await page.click('#mt-add');
  await page.locator('[data-pick-clip]').last().click();
  await page.click('[data-close-picker]');
  assert.equal(await page.locator('.seq-item').count(), 3);

  // trim the selected (last) segment
  await page.fill('#mt-seg-start', '1');
  await page.locator('#mt-seg-start').dispatchEvent('change');
  await page.fill('#mt-seg-end', '3');
  await page.locator('#mt-seg-end').dispatchEvent('change');

  // text overlay
  await page.click('.tab[data-tab="texts"]');
  await page.click('#mt-text-add');
  await page.fill('.text-item textarea', "TOP 3 de l'été");
  await page.locator('.text-item select[data-k="position"]').selectOption('top');
  await page.waitForSelector('.ov-text');
  assert.equal((await page.textContent('.ov-text')).trim(), "TOP 3 de l'été");

  // style
  await page.click('.tab[data-tab="style"]');
  await page.click('[data-bind="fit"] [data-value="crop"]');
  await page.locator('#mt-transition').selectOption('slideleft');

  // music upload
  await page.click('.tab[data-tab="music"]');
  await page.setInputFiles('#mt-music-file', path.join(TMP, 'chill beat.mp3'));
  await page.waitForSelector('.music-item input[value="chill beat.mp3"]:checked');

  // playback advances
  await page.click('#mt-play');
  await page.waitForTimeout(1200);
  await page.click('#mt-play');
  const time = await page.textContent('#mt-time');
  assert.notEqual(time, '0:00.0');

  await page.fill('#mt-name', 'Best of semaine');
  await page.waitForSelector('#mt-saved:has-text("Enregistré")');
  await shot('3-montage-editor');

  // persisted server-side
  const projects = await (await fetch(`${BASE}/api/projects`)).json();
  const saved = projects.find((p) => p.name === 'Best of semaine');
  assert.equal(saved.segments, 3);
  const detail = await (await fetch(`${BASE}/api/projects/${saved.id}`)).json();
  assert.equal(detail.data.fit, 'crop');
  assert.equal(detail.data.transition, 'slideleft');
  assert.equal(detail.data.music.file, 'chill beat.mp3');
  assert.equal(detail.data.texts[0].position, 'top');

  await page.click('#mt-render');
  await page.waitForSelector('.toast:has-text("Rendu lancé")');
  await page.click('[data-close-montage]');
  await page.waitForSelector('.card[data-project]');
});

t('exports page renders montage, publish dialog flows', async () => {
  await page.click('[data-nav="exports"]');
  await page.waitForSelector('.export-row');
  await page.waitForFunction(() => document.querySelectorAll('[data-publish]').length >= 2, null, { timeout: 90_000 });
  assert.match(await page.textContent('.export-row:first-child'), /Best of semaine – montage 9:16/);
  await shot('4-exports');

  await page.locator('[data-publish]').first().click();
  await page.waitForSelector('#publish[open] #yt-cid');
  await shot('5-publish-youtube-setup');

  await page.click('[data-ptab="tiktok"]');
  await page.waitForSelector('#man-caption');
  assert.match(await page.inputValue('#man-caption'), /#fyp/);
  await page.click('[data-manual="done"]');
  await page.waitForSelector('.pub.done:has-text("TikTok")');
  await shot('6-published');
});

t('clip editor shows detected highlights and selects one', async () => {
  await page.keyboard.press('Escape');
  await page.click('[data-nav="game"][data-game="Valorant"]');
  await page.waitForSelector('.page-head h1:has-text("Valorant")');
  await page.locator('.card').first().click();
  await page.waitForSelector('#ed-highlights .hl');
  assert.ok(await page.locator('#ed-marks .mark').count() >= 1);
  await page.locator('#ed-highlights .hl').first().click();
  const [from, to] = (await page.textContent('#ed-sel-range')).split(' → ');
  const sec = (tc) => { const [m, x] = tc.split(':'); return Number(m) * 60 + Number(x); };
  assert.ok(sec(from) <= 5.3 && sec(to) >= 5.5, `selection ${from} → ${to} covers the burst`);
  await shot('7-highlights');
  await page.click('[data-close-editor]');
});

t('best-of auto from a selection', async () => {
  await page.click('[data-nav="all"]');
  await page.waitForSelector('.card');
  await page.locator('.card').nth(0).click({ modifiers: ['Shift'] });
  await page.locator('.card').nth(1).click({ modifiers: ['Shift'] });
  await page.click('#selbar-auto');
  await page.waitForSelector('#montage:not([hidden]) .seq-item');
  // two moments, the best one replayed in slow motion
  assert.equal(await page.locator('.seq-item').count(), 3);
  assert.equal(await page.locator('.seq-item .seq-fx', { hasText: '0,5×' }).count(), 1);
  assert.match(await page.inputValue('#mt-name'), /Best-of auto/);
  await page.locator('.seq-item', { has: page.locator('.seq-fx', { hasText: '0,5×' }) }).click();
  assert.equal(await page.locator('#mt-seg-speed button.active').textContent(), '½×');
  await shot('7b-bestof-effects');
  await page.click('.tab[data-tab="style"]');
  await page.locator('[data-bind="fit"] [data-value="stack"]').click();
  await page.selectOption('#mt-grade', 'vivid');
  await page.check('#mt-progress');
  assert.equal(await page.getAttribute('#mt-canvas', 'data-grade'), 'vivid');
  await shot('7c-style-stack');
});

t('templates: apply a built-in, save the current style', async () => {
  await page.click('#mt-templates');
  await page.waitForSelector('#templates[open] .tpl');
  await page.locator('.tpl', { hasText: 'YouTube classique' }).locator('[data-apply-tpl]').click();
  await page.waitForSelector('.toast:has-text("Modèle appliqué")');
  const box = await page.locator('#mt-canvas').boundingBox();
  assert.ok(box.width > box.height, 'preview switched to 16:9');

  await page.click('#mt-templates');
  await page.fill('#tpl-name', 'Mon style');
  await page.click('#tpl-save');
  await page.waitForSelector('.tpl:has-text("Mon style")');
  await shot('8-templates');
  await page.click('[data-close-templates]');
  await page.click('.tab[data-tab="texts"]');
  assert.equal(await page.isVisible('#sub-run'), true);
  await page.click('[data-close-montage]');
});

t('settings: phone access shows a QR code', async () => {
  await page.click('#btn-settings');
  await page.check('#set-remote');
  await page.waitForSelector('#remote-qr svg');
  assert.match(await page.textContent('#remote-url'), /^http:\/\/[\d.]+:\d+\/\?key=/);
  await shot('9-phone-qr');
  await page.uncheck('#set-remote');
  await page.waitForSelector('#remote-info', { state: 'hidden' });
  await page.click('#settings button[value="cancel"]');
});

t('phone layout: drawer menu, import button, stacked editor', async () => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(BASE);
  await phone.waitForSelector('.card');
  assert.equal(await phone.isVisible('#btn-menu'), true);
  assert.equal(await phone.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right <= 0), true);
  await phone.click('#btn-menu');
  await phone.waitForTimeout(300);
  assert.equal(await phone.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left >= 0), true);
  await phone.screenshot({ path: path.join(SHOTS, '10-phone-menu.png') });
  await phone.click('[data-nav="all"]');
  await phone.waitForTimeout(300);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `no horizontal scroll (${overflow}px)`);
  await phone.screenshot({ path: path.join(SHOTS, '11-phone-library.png') });
  await phone.locator('.card').first().click();
  await phone.waitForSelector('#editor:not([hidden])');
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: path.join(SHOTS, '12-phone-editor.png'), fullPage: true });
  await phone.close();
});

t('montage list and no browser errors', async () => {
  await page.click('[data-nav="projects"]');
  await page.waitForSelector('.card[data-project]');
  assert.ok(await page.locator('.card[data-project]').count() >= 3);
  assert.deepEqual(errors, []);
});
