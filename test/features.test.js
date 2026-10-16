// End-to-end: highlights, auto best-of, templates, subtitles (real Whisper), phone access.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-feat-'));
const CLIPS = path.join(TMP, 'clips');
const PORT = 5400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;
let log = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  const res = await fetch(url.startsWith('http') ? url : BASE + url, {
    redirect: 'manual',
    ...opts,
    headers: typeof opts.body === 'string' ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
const post = (url, data, headers) => api(url, { method: 'POST', body: JSON.stringify(data ?? {}), headers });
const put = (url, data) => api(url, { method: 'PUT', body: JSON.stringify(data) });

async function waitJob(job, timeout = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await api(`/api/jobs/${job.id}`);
    if (body.status === 'done') return body.result;
    if (body.status === 'failed') throw new Error(body.error);
    if (Date.now() - t0 > timeout) throw new Error(`job timeout\n${log.slice(-1500)}`);
    await sleep(300);
  }
}

function ff(...args) {
  execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args]);
}

before(async () => {
  fs.mkdirSync(CLIPS, { recursive: true });
  // loud bursts at 5 s and 13 s over a quiet tone
  ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=20',
    '-f', 'lavfi', '-i', "aevalsrc='0.03*sin(2*PI*300*t)+if(between(t,5,5.8)+between(t,13,13.5),0.9*(random(0)-0.5),0)':s=48000:d=20",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(CLIPS, 'Valorant 2026-10-15 21-04-33.mp4'));
  // a burst at 2 s in a second clip
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8',
    '-f', 'lavfi', '-i', "aevalsrc='0.02*sin(2*PI*200*t)+if(between(t,2,2.6),0.9*(random(0)-0.5),0)':s=48000:d=8",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(CLIPS, 'Valorant 2026-10-14 20-00-00.mp4'));
  // speech (JFK, public domain) for subtitles
  ff('-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30:duration=11', '-i', path.join(ROOT, 'test/fixtures/jfk.wav'),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(CLIPS, 'Discours 2026-10-13 12-00-00.mp4'));

  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), // a hidden folder, like the desktop app's ~/.config/ClipForge
      CLIPFORGE_DATA: path.join(TMP, '.config', 'data'), CLIPFORGE_CLIPS: CLIPS,
      // share the model cache with the app so Whisper is downloaded only once
      CLIPFORGE_MODELS: path.join(ROOT, 'data', 'models'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 150; i++) {
    const { body } = await api('/api/clips').catch(() => ({ body: [] }));
    if (body.length === 3) return;
    await sleep(200);
  }
  throw new Error(`clips not scanned\n${log}`);
});

after(() => {
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const clipByName = async (frag) => (await api('/api/clips')).body.find((c) => c.filename.includes(frag));

test('detects the loud moments of a clip and caches the analysis', async () => {
  const clip = await clipByName('21-04-33');
  const t0 = Date.now();
  const { body } = await api(`/api/clips/${clip.id}/highlights`);
  assert.equal(body.source, 'audio');
  assert.ok(Math.abs(body.highlights[0].time - 5.4) < 0.6, `first peak at ${body.highlights[0].time}`);
  assert.ok(Math.abs(body.highlights[1].time - 13.3) < 0.6, `second peak at ${body.highlights[1].time}`);
  assert.ok(body.curve.length > 10 && body.curve.every((v) => v >= 0 && v <= 1));
  const first = Date.now() - t0;
  const t1 = Date.now();
  await api(`/api/clips/${clip.id}/highlights`);
  assert.ok(Date.now() - t1 <= Math.max(first, 50), 'second call served from cache');
});

test('auto best-of keeps each clip’s best moment, in recording order, within budget', async () => {
  const a = await clipByName('21-04-33');
  const b = await clipByName('20-00-00');
  const { body: job } = await post('/api/projects/auto', { clipIds: [a.id, b.id], maxDuration: 30 });
  const { projectId } = await waitJob(job);
  const { body: p } = await api(`/api/projects/${projectId}`);
  assert.deepEqual(p.data.segments.map((s) => s.clipId), [b.id, a.id], 'oldest recording first');
  const [sb, sa] = p.data.segments;
  assert.ok(sb.start <= 2 && sb.end >= 2.5, 'covers the 2 s burst');
  assert.ok(sa.start <= 5.4 && sa.end >= 5.6, 'covers the 5 s burst');

  const { body: tight } = await post('/api/projects/auto', { clipIds: [a.id, b.id], perClip: 2, maxDuration: 8 });
  const { body: p2 } = await api(`/api/projects/${(await waitJob(tight)).projectId}`);
  const total = p2.data.segments.reduce((t, s) => t + s.end - s.start, 0);
  assert.ok(total <= 8 + 1e-6, `budget respected (${total})`);
});

test('templates: built-ins, save from a project, apply, create from', async () => {
  const { body: list } = await api('/api/templates');
  assert.ok(list.some((t) => t.name === 'TikTok dynamique' && t.builtin));

  const clip = await clipByName('21-04-33');
  const { body: src } = await post('/api/projects', {
    clipIds: [clip.id],
    data: { format: 'landscape', fit: 'bars', transition: 'zoomin', texts: [{ text: '@moi', start: 0, end: 9999, position: 'top' }] },
  });
  const { body: tpl } = await post('/api/templates', { name: 'Ma signature', projectId: src.id });
  assert.equal(tpl.data.transition, 'zoomin');
  assert.equal(tpl.data.segments, undefined);

  const { body: fresh } = await post('/api/projects', { clipIds: [clip.id], templateId: tpl.id });
  assert.equal(fresh.data.format, 'landscape');
  assert.equal(fresh.data.texts[0].text, '@moi');

  const { body: other } = await post('/api/projects', { clipIds: [clip.id] });
  const tiktok = list.find((t) => t.name === 'TikTok dynamique');
  const { body: applied } = await post(`/api/projects/${other.id}/apply-template`, { templateId: tiktok.id });
  assert.deepEqual([applied.data.fit, applied.data.fps, applied.data.transition], ['crop', 60, 'slideleft']);

  // "until the end" text renders fine (clamped to the montage length)
  const { body: job } = await post(`/api/projects/${fresh.id}/render`);
  for (let i = 0; i < 200; i++) {
    const e = (await api('/api/exports')).body.find((x) => x.id === job.id);
    if (e.status === 'failed') throw new Error(e.error);
    if (e.status === 'done') break;
    await sleep(300);
  }

  await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
  assert.ok(!(await api('/api/templates')).body.some((t) => t.id === tpl.id));
});

test('automatic subtitles from real speech (Whisper, local)', { timeout: 600_000 }, async (t) => {
  const clip = await clipByName('Discours');
  const { body: project } = await post('/api/projects', { clipIds: [clip.id], data: { transition: 'none' } });
  // keep a manual text: regeneration must not touch it
  await put(`/api/projects/${project.id}`, { data: { ...project.data, texts: [{ text: 'TITRE', start: 0, end: 2 }] } });

  const { body: job } = await post(`/api/projects/${project.id}/subtitles`, {
    language: 'english', maxWords: 4, upper: true, style: { position: 'center', size: 'L', box: false },
  });
  let result;
  try {
    result = await waitJob(job);
  } catch (err) {
    if (/indisponible|fetch|ENOTFOUND|network/i.test(err.message)) return t.skip(`Whisper model unavailable: ${err.message}`);
    throw err;
  }
  assert.ok(result.count >= 5, `got ${result.count} captions`);

  const { body: p } = await api(`/api/projects/${project.id}`);
  const subs = p.data.texts.filter((x) => x.auto);
  const all = subs.map((s) => s.text).join(' ');
  assert.match(all, /COUNTRY/);
  assert.match(all, /AMERICANS/);
  assert.ok(subs.every((s) => s.text.split(' ').length <= 4));
  assert.ok(subs.every((s) => s.position === 'center' && s.size === 'L' && !s.box));
  assert.ok(subs.every((s, i) => i === 0 || s.start >= subs[i - 1].end - 1e-6), 'no overlap');
  assert.ok(subs.every((s) => s.end <= 11.1));
  assert.ok(p.data.texts.some((x) => x.text === 'TITRE' && !x.auto), 'manual text kept');

  // regenerating replaces the previous subtitles instead of stacking them
  const again = await waitJob((await post(`/api/projects/${project.id}/subtitles`, { language: 'english' })).body);
  const { body: p2 } = await api(`/api/projects/${project.id}`);
  assert.equal(p2.data.texts.filter((x) => x.auto).length, again.count);
});

test('fight layout: vertical export with tracked camera, normalised loudness', { timeout: 300_000 }, async () => {
  const clip = await clipByName('21-04-33');
  const { body: job } = await post(`/api/clips/${clip.id}/export`, { start: 2, end: 8, format: 'vertical-fight' });
  let e;
  for (let i = 0; i < 600; i++) {
    e = (await api('/api/exports')).body.find((x) => x.id === job.id);
    if (e.status === 'failed') throw new Error(e.error);
    if (e.status === 'done') break;
    await sleep(300);
  }
  assert.equal(e.status, 'done');
  const info = JSON.parse(execFileSync(ffprobeStatic.path, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', e.out_path,
  ], { encoding: 'utf8' }));
  const v = info.streams.find((x) => x.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.15);

  // integrated loudness close to the -14 LUFS target (ebur128 reports on stderr)
  const { stderr } = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', e.out_path, '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const lufs = Number(stderr.match(/I:\s+(-?[\d.]+) LUFS/g).at(-1).match(/-?[\d.]+/)[0]);
  assert.ok(Math.abs(lufs - -14) < 2, `loudness ${lufs} LUFS`);
});

async function waitExport(id) {
  for (let i = 0; i < 1000; i++) {
    const e = (await api('/api/exports')).body.find((x) => x.id === id);
    if (e.status === 'failed') throw new Error(e.error);
    if (e.status === 'done') return e;
    await sleep(300);
  }
  throw new Error('export timeout');
}

const probe = (file) => JSON.parse(execFileSync(ffprobeStatic.path, [
  '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
], { encoding: 'utf8' }));

test('any game: "follow" and "stack" single-clip exports', { timeout: 300_000 }, async () => {
  const clip = await clipByName('21-04-33');
  for (const format of ['vertical-follow', 'vertical-stack']) {
    const { body: job } = await post(`/api/clips/${clip.id}/export`, { start: 1, end: 5, format });
    const e = await waitExport(job.id);
    const info = probe(e.out_path);
    const v = info.streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1080, 1920], format);
    assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.15, `${format} ${info.format.duration}`);
    const media = await fetch(`${BASE}/media/exports/${e.id}`);
    assert.equal(media.status, 200, 'served from a hidden data folder');
    assert.equal((await fetch(`${BASE}/media/exports/${e.id}?download=1`)).status, 200);
  }
});

test('punchy montage: slow motion, impact, look, progress bar, beat-synced music with ducking', { timeout: 300_000 }, async () => {
  // a 120 BPM kick track
  const music = path.join(TMP, 'kick.wav');
  ff('-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*60*t)*exp(-30*mod(t,0.5))':s=44100:d=6", music);
  const up = await api('/api/music', { method: 'POST', body: fs.readFileSync(music), headers: { 'x-filename': 'kick.wav' } });
  assert.equal(up.status, 200);
  assert.equal((await fetch(`${BASE}/media/music/${up.body.file}`)).status, 200);

  const clip = await clipByName('21-04-33');
  const { body: p } = await post('/api/projects', {
    data: {
      format: 'vertical', fit: 'follow', transition: 'none', grade: 'punchy', progressBar: true,
      beatSync: true, duck: true, music: { file: up.body.file, volume: 0.6 },
      segments: [
        { clipId: clip.id, start: 3, end: 6.3, impact: 5.2 },
        { clipId: clip.id, start: 4.5, end: 5.8, speed: 0.5, impact: 5.2 },
      ],
    },
  });
  assert.equal(p.data.segments[1].speed, 0.5);
  const { body: job } = await post(`/api/projects/${p.id}/render`);
  const e = await waitExport(job.id);
  const info = probe(e.out_path);
  // the 3.3 s cut moves to the nearest beat (3.5 s), then 1.3 s of clip at half speed
  assert.ok(Math.abs(Number(info.format.duration) - (3.5 + 2.6)) < 0.15, `duration ${info.format.duration}`);
  assert.ok(info.streams.some((x) => x.codec_type === 'audio'));
});

test('cross-site requests are refused', async () => {
  assert.equal((await post('/api/scan', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/scan', {}, { origin: BASE })).status, 200);
  // DNS rebinding: a foreign domain resolving to 127.0.0.1 is refused, even same-origin
  const status = (host) => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: PORT, path: '/api/settings', headers: { host } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(await status(`attaquant.example:${PORT}`), 421);
  assert.equal(await status(`localhost:${PORT}`), 200);
});

test('phone access: off by default, key required, PC-only settings', async (t) => {
  const { body: off } = await api('/api/remote');
  assert.equal(off.enabled, false);

  const { body: on } = await put('/api/remote', { enabled: true });
  assert.equal(on.enabled, true);
  if (!on.urls.length) return t.skip('no LAN interface on this machine');
  assert.match(on.qrs[0], /<svg/);

  const url = new URL(on.urls[0]);
  const lan = `http://${url.host}`;
  assert.equal((await api(`${lan}/api/clips`)).status, 401, 'no key');
  assert.equal((await api(`${lan}/?key=wrong`)).status, 401, 'bad key');

  const login = await api(on.urls[0]);
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const clips = await api(`${lan}/api/clips`, { headers: { cookie } });
  assert.equal(clips.status, 200);
  assert.equal(clips.body.length, 3);

  // a phone can't change PC settings or read the key
  assert.equal((await api(`${lan}/api/remote`, { headers: { cookie } })).status, 403);
  assert.equal((await api(`${lan}/api/settings`, { method: 'PUT', body: '{"clipsDir":"/"}', headers: { cookie, 'content-type': 'application/json' } })).status, 403);

  // rotating the key logs the phone out
  await put('/api/remote', { enabled: true, rotate: true });
  assert.equal((await api(`${lan}/api/clips`, { headers: { cookie } })).status, 401);

  await put('/api/remote', { enabled: false });
  await assert.rejects(fetch(`${lan}/api/clips`), 'LAN listener closed');
});
