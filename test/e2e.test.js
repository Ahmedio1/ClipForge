// End-to-end: real server process, real ffmpeg renders, fake Google for the YouTube flow.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-e2e-'));
const CLIPS = path.join(TMP, 'clips');
const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

let server;
let serverLog = '';
let google;
const googleCalls = { uploads: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 60_000, every = 250, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timeout waiting for ${what}\n${serverLog.slice(-2000)}`);
    await sleep(every);
  }
}

async function api(url, opts = {}) {
  const res = await fetch(BASE + url, {
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
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data ?? {}) });
const put = (url, data) => api(url, { method: 'PUT', body: JSON.stringify(data) });

function makeClip(file, { size = '640x360', seconds = 6, audio = true, src = 'testsrc2' } = {}) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=${size}:rate=30:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, args);
}

function probe(file) {
  const out = JSON.parse(execFileSync(ffprobeStatic.path, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { encoding: 'utf8' }));
  const v = out.streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(out.format.duration),
    width: v.width,
    height: v.height,
    audio: out.streams.some((s) => s.codec_type === 'audio'),
  };
}

async function waitExport(id) {
  return waitFor(async () => {
    const { body } = await api('/api/exports');
    const e = body.find((x) => x.id === id);
    if (e?.status === 'failed') throw new Error(`Export ${id} failed: ${e.error}`);
    return e?.status === 'done' && e;
  }, { timeout: 120_000, what: `export ${id}` });
}

function startGoogle() {
  return new Promise((resolve) => {
    google = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const json = (code, data, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };

      if (url.pathname === '/token') {
        const p = new URLSearchParams(body.toString());
        if (p.get('client_secret') !== 'secret') return json(401, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code') {
          if (p.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
          googleCalls.redirectUri = p.get('redirect_uri');
          return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
        }
        return json(200, { access_token: 'at-2', expires_in: 3600 });
      }
      if (req.headers.authorization?.startsWith('Bearer at-') !== true) return json(401, { error: { message: 'no auth' } });
      if (url.pathname === '/youtube/v3/channels') {
        return json(200, { items: [{ id: 'UC123', snippet: { title: 'Ma Chaîne Gaming' } }] });
      }
      if (url.pathname === '/upload/youtube/v3/videos' && req.method === 'POST') {
        googleCalls.uploads.push({ meta: JSON.parse(body.toString()), declared: Number(req.headers['x-upload-content-length']) });
        res.writeHead(200, { location: `http://localhost:${google.address().port}/session/1` });
        return res.end();
      }
      if (url.pathname === '/session/1' && req.method === 'PUT') {
        googleCalls.uploads.at(-1).received = body.length;
        return json(200, { id: 'vid_abc' });
      }
      json(404, { error: { message: 'not found' } });
    });
    google.listen(0, () => resolve());
  });
}

before(async () => {
  makeClip(path.join(CLIPS, 'Valorant 2026-10-15 21-04-33.mp4'), { seconds: 8 });
  makeClip(path.join(CLIPS, 'Rocket League 10_14_2026 9_15_02 PM.mp4'), { size: '1280x720', audio: false, src: 'testsrc' });
  makeClip(path.join(CLIPS, 'Minecraft', 'sans date.mp4'), { seconds: 4 });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
    '-c:a', 'libmp3lame', path.join(TMP, 'beat.mp3')]);

  await startGoogle();
  const g = `http://localhost:${google.address().port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS,
      YT_AUTH_URL: `${g}/auth`, YT_TOKEN_URL: `${g}/token`, YT_API_BASE: g,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitFor(() => fetch(`${BASE}/api/status`).then((r) => r.ok, () => false), { what: 'server start' });
});

after(() => {
  server?.kill();
  google?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---- Library -----------------------------------------------------------------------

test('scans the folder and groups clips by game', async () => {
  const games = await waitFor(async () => {
    const { body } = await api('/api/games');
    return body.length === 3 && body;
  }, { what: 'initial scan' });
  assert.deepEqual(games.map((g) => g.game).sort(), ['Minecraft', 'Rocket League', 'Valorant']);

  const { body: clips } = await api('/api/clips');
  const valorant = clips.find((c) => c.game === 'Valorant');
  assert.equal(valorant.recorded_at, '2026-10-15T21:04:33');
  assert.ok(Math.abs(valorant.duration - 8) < 0.2);
  assert.equal(valorant.has_audio, 1);
  assert.equal(clips.find((c) => c.game === 'Rocket League').has_audio, 0);
});

test('search, favorites and metadata edits', async () => {
  const { body: [clip] } = await api('/api/clips?q=valo');
  assert.equal(clip.game, 'Valorant');
  const { body: edited } = await api(`/api/clips/${clip.id}`, {
    method: 'PATCH', body: JSON.stringify({ title: 'Ace en ranked', tags: 'ace, clutch', favorite: true }),
  });
  assert.equal(edited.title, 'Ace en ranked');
  assert.equal((await api('/api/clips?favorite=1')).body.length, 1);
  assert.equal((await api('/api/clips?q=clutch')).body[0].id, clip.id);
});

test('serves video with byte ranges and thumbnails', async () => {
  const { body: [clip] } = await api('/api/clips?q=valo');
  const res = await fetch(`${BASE}/media/clips/${clip.id}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 100);
  const thumb = await fetch(`${BASE}/media/thumbs/${clip.id}`);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
});

test('detects a new file dropped into the folder', async () => {
  makeClip(path.join(CLIPS, 'Fortnite 2026-10-12 20-00-00.mp4'), { seconds: 3 });
  await waitFor(async () => (await api('/api/clips?game=Fortnite')).body.length === 1, { what: 'watcher pickup' });
});

test('drag & drop upload accepts videos only', async () => {
  const file = fs.readFileSync(path.join(CLIPS, 'Fortnite 2026-10-12 20-00-00.mp4'));
  const ok = await api('/api/upload', {
    method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent('Apex Légends 2026-10-11 10-00-00.mp4') },
  });
  assert.equal(ok.status, 200);
  const bad = await api('/api/upload', { method: 'POST', body: 'x', headers: { 'x-filename': 'evil.sh' } });
  assert.equal(bad.status, 400);
  await waitFor(async () => (await api('/api/clips?game=Apex%20L%C3%A9gends')).body.length === 1, { what: 'upload scan' });
});

test('marks deleted files as missing', async () => {
  fs.rmSync(path.join(CLIPS, 'Fortnite 2026-10-12 20-00-00.mp4'));
  await post('/api/scan');
  await waitFor(async () => (await api('/api/clips?game=Fortnite')).body.length === 0, { what: 'missing detection' });
});

// ---- Clip exports ------------------------------------------------------------------

test('exports a trimmed clip in all three formats', async () => {
  const { body: [clip] } = await api('/api/clips?q=valo');
  const expected = { original: [640, 360], 'vertical-blur': [1080, 1920], 'vertical-crop': [1080, 1920] };
  for (const [format, [w, h]] of Object.entries(expected)) {
    const { body: job } = await post(`/api/clips/${clip.id}/export`, { start: 1, end: 4.5, format });
    const done = await waitExport(job.id);
    const info = probe(done.out_path);
    assert.deepEqual([info.width, info.height], [w, h], format);
    assert.ok(Math.abs(info.duration - 3.5) < 0.15, `${format} duration ${info.duration}`);
    assert.ok(info.audio);
  }
});

test('mute export has no audio track; bad selection is rejected', async () => {
  const { body: [clip] } = await api('/api/clips?q=valo');
  const { body: job } = await post(`/api/clips/${clip.id}/export`, { start: 0, end: 2, format: 'original', mute: true });
  assert.equal(probe((await waitExport(job.id)).out_path).audio, false);
  assert.equal((await post(`/api/clips/${clip.id}/export`, { start: 2, end: 2.1 })).status, 400);
});

test('downloads and deletes an export', async () => {
  const { body: list } = await api('/api/exports');
  const e = list.find((x) => x.status === 'done');
  const dl = await fetch(`${BASE}/media/exports/${e.id}?download=1`);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await api(`/api/exports/${e.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(e.out_path), false);
});

// ---- Montages ----------------------------------------------------------------------

test('music library: upload, list, reject non-audio', async () => {
  const res = await api('/api/music', {
    method: 'POST', body: fs.readFileSync(path.join(TMP, 'beat.mp3')), headers: { 'x-filename': 'beat.mp3' },
  });
  assert.equal(res.body.file, 'beat.mp3');
  const { body: list } = await api('/api/music');
  assert.ok(Math.abs(list[0].duration - 3) < 0.2);
  const bad = await api('/api/music', { method: 'POST', body: 'not audio', headers: { 'x-filename': 'fake.mp3' } });
  assert.equal(bad.status, 400);
  assert.equal((await api('/api/music')).body.length, 1);
});

test('renders a full montage: transitions, texts, music, vertical', async () => {
  const { body: clips } = await api('/api/clips');
  const byGame = Object.fromEntries(clips.map((c) => [c.game, c]));
  const { body: project } = await post('/api/projects', {
    name: 'Best of été', clipIds: [byGame.Valorant.id, byGame['Rocket League'].id],
  });
  assert.equal(project.segments, 2);

  // add a third segment the way the clip editor does
  const { body: withThird } = await post(`/api/projects/${project.id}/segments`,
    { clipId: byGame.Minecraft.id, start: 1, end: 3.5 });
  assert.equal(withThird.data.segments.length, 3);

  const data = {
    ...withThird.data,
    format: 'vertical', fit: 'blur', transition: 'wipeleft', transitionDuration: 0.5,
    segments: withThird.data.segments.map((s, i) => (i === 0 ? { ...s, start: 2, end: 6 } : s)),
    texts: [{ text: "L'ACE de l'été : 100% clutch", start: 0, end: 2, position: 'top', size: 'L' }],
    music: { file: 'beat.mp3', volume: 0.3 },
  };
  const { body: saved } = await put(`/api/projects/${project.id}`, { data });
  // 4 + 6 + 2.5 - 2 transitions × 0.5
  assert.ok(Math.abs(saved.duration - 11.5) < 0.01, `planned ${saved.duration}`);

  const { body: job } = await post(`/api/projects/${project.id}/render`);
  const info = probe((await waitExport(job.id)).out_path);
  assert.deepEqual([info.width, info.height], [1080, 1920]);
  assert.ok(Math.abs(info.duration - 11.5) < 0.2, `duration ${info.duration}`);
  assert.ok(info.audio);
  assert.equal(fs.readdirSync(path.join(TMP, 'data', 'exports')).filter((f) => f.endsWith('.mkv')).length, 0,
    'temp pass-1 file cleaned up');
});

test('landscape montage with hard cuts and letterboxing', async () => {
  const { body: clips } = await api('/api/clips');
  const { body: project } = await post('/api/projects', {
    clipIds: clips.slice(0, 2).map((c) => c.id),
    data: { format: 'landscape', fit: 'bars', transition: 'none', fadeInOut: false },
  });
  const { body: job } = await post(`/api/projects/${project.id}/render`);
  const info = probe((await waitExport(job.id)).out_path);
  assert.deepEqual([info.width, info.height], [1920, 1080]);
  assert.ok(Math.abs(info.duration - project.duration) < 0.2);
});

test('empty montage cannot render; projects list and delete', async () => {
  const { body: empty } = await post('/api/projects', { name: 'Vide' });
  assert.equal((await post(`/api/projects/${empty.id}/render`)).status, 400);
  assert.ok((await api('/api/projects')).body.some((p) => p.name === 'Best of été'));
  await api(`/api/projects/${empty.id}`, { method: 'DELETE' });
  assert.equal((await api(`/api/projects/${empty.id}`)).status, 404);
});

// ---- Publishing --------------------------------------------------------------------

test('YouTube: connect via OAuth, upload with metadata, schedule validation', async () => {
  assert.equal((await api('/api/youtube')).body.configured, false);
  assert.equal((await put('/api/youtube/credentials', { clientId: 'cid', clientSecret: 'secret' })).status, 200);

  const connect = await api('/api/youtube/connect');
  assert.equal(connect.status, 302);
  const authUrl = new URL(connect.headers.get('location'));
  assert.equal(authUrl.searchParams.get('client_id'), 'cid');
  assert.match(authUrl.searchParams.get('scope'), /youtube\.upload/);

  const forged = await api('/api/youtube/callback?code=good-code&state=forged');
  assert.match(forged.headers.get('location'), /youtube=error/);

  // the forged attempt doesn't consume the real state, but a new connect issues a fresh one
  const fresh = new URL((await api('/api/youtube/connect')).headers.get('location'));
  const cb = await api(`/api/youtube/callback?code=good-code&state=${fresh.searchParams.get('state')}`);
  assert.equal(cb.headers.get('location'), '/#youtube=connected');
  const status = (await api('/api/youtube')).body;
  assert.equal(status.connected, true);
  assert.equal(status.channel.title, 'Ma Chaîne Gaming');
  assert.equal(googleCalls.redirectUri, `http://localhost:${PORT}/api/youtube/callback`);

  const { body: exportsList } = await api('/api/exports');
  const exp = exportsList.find((e) => e.status === 'done' && e.project_id);

  assert.equal((await post(`/api/exports/${exp.id}/publish`, { platform: 'youtube' })).status, 400, 'title required');
  assert.equal((await post(`/api/exports/${exp.id}/publish`, {
    platform: 'youtube', title: 't', publishAt: '2001-01-01T00:00',
  })).status, 400, 'past schedule rejected');

  const publishAt = new Date(Date.now() + 86_400_000).toISOString();
  const { body: pub } = await post(`/api/exports/${exp.id}/publish`, {
    platform: 'youtube', title: 'Best of été #Shorts', description: 'GG', tags: '#valorant, clutch',
    privacy: 'public', publishAt, short: true,
  });
  const done = await waitFor(async () => {
    const p = (await api('/api/publications')).body.find((x) => x.id === pub.id);
    if (p?.status === 'failed') throw new Error(p.error);
    return p?.status === 'done' && p;
  }, { what: 'youtube upload' });
  assert.equal(done.url, 'https://youtube.com/shorts/vid_abc');

  const up = googleCalls.uploads.at(-1);
  assert.equal(up.received, up.declared, 'full file uploaded');
  assert.equal(up.received, fs.statSync(exp.out_path).size);
  assert.equal(up.meta.snippet.categoryId, '20');
  assert.deepEqual(up.meta.snippet.tags, ['valorant', 'clutch']);
  assert.equal(up.meta.status.privacyStatus, 'private', 'scheduled videos must be private until publishAt');
  assert.equal(up.meta.status.publishAt, publishAt);
});

test('manual platforms are logged; disconnect clears tokens', async () => {
  const { body: exportsList } = await api('/api/exports');
  const exp = exportsList.find((e) => e.status === 'done');
  const { body: pub } = await post(`/api/exports/${exp.id}/publish`, { platform: 'tiktok', description: 'gg #fyp' });
  assert.equal(pub.status, 'done');
  assert.equal((await post(`/api/exports/${exp.id}/publish`, { platform: 'myspace' })).status, 400);

  const { body: status } = await post('/api/youtube/disconnect');
  assert.equal(status.connected, false);
  assert.equal(status.configured, true);
  const data = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'youtube.json'), 'utf8'));
  assert.equal(data.refreshToken, undefined);
});
