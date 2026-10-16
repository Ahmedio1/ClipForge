// Cloud sources: real rclone sync from a local "NAS" folder, and the account set-up flows
// (browser OAuth, 2FA code) against a fake rclone that passes everything else to the real one.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { parseConfigOutput, parseStats, toQuestion } from '../server/rclone-output.js';
import { extractEntry, zipEntries } from '../server/unzip.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_RCLONE = [path.join(ROOT, 'data/bin/rclone'), '/usr/bin/rclone'].find((p) => fs.existsSync(p));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-cloud-'));
const CLIPS = path.join(TMP, 'clips');
const NAS = path.join(TMP, 'nas');
const PORT = 6000 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;
let log = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (url, opts = {}) => {
  const res = await fetch(BASE + url, {
    ...opts, headers: opts.body ? { 'content-type': 'application/json' } : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data ?? {}) });

async function waitFor(fn, what, timeout = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}\n${log.slice(-1500)}`);
    await sleep(250);
  }
}

const FAKE_RCLONE = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const i = args.indexOf('config', 2);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 1));
const q = (state, name, help, extra = {}) => out({ State: state, Option: { Name: name, Help: help, DefaultStr: '', Examples: [], IsPassword: false, Type: 'string', ...extra }, Error: extra.error || '' });
if (i < 0) {
  const r = spawnSync(${JSON.stringify(REAL_RCLONE)}, args, { stdio: 'inherit' });
  process.exit(r.status);
}
const [cmd, , type] = args.slice(i + 1);
const state = args[args.indexOf('--state') + 1];
const result = args[args.indexOf('--result') + 1];
if (cmd === 'create' && type === 'dropbox') q('*oauth-islocal,,,', 'config_is_local', 'Use web browser?', { Type: 'bool' });
else if (cmd === 'create' && type === 'iclouddrive') q('2fa', 'config_2fa', 'Code à deux facteurs');
else if (cmd === 'create') out({ State: '' });
else if (cmd === 'update' && state.startsWith('*oauth')) {
  process.stderr.write('NOTICE: If your browser doesn\\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=abc\\n');
  setTimeout(() => out({ State: '' }), 1500);
} else if (cmd === 'update' && state === '2fa') {
  if (result === '123456') out({ State: '' });
  else q('2fa', 'config_2fa', 'Code à deux facteurs', { error: 'Code invalide' });
} else if (cmd === 'delete') {}
else { process.stderr.write('unexpected ' + args.join(' ')); process.exit(2); }
`;

function makeVideo(file, seconds = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', file]);
}

before(async () => {
  if (!REAL_RCLONE) return;
  fs.mkdirSync(CLIPS, { recursive: true });
  makeVideo(path.join(NAS, 'TEKKEN™8 2026-10-01 20-00-00.mp4'));
  makeVideo(path.join(NAS, 'Street Fighter 6', 'combo.mp4'));
  makeVideo(path.join(NAS, 'vieux clip.mp4'));
  fs.writeFileSync(path.join(NAS, 'notes.txt'), 'pas une vidéo');
  const old = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(path.join(NAS, 'vieux clip.mp4'), old, old);

  const fake = path.join(TMP, 'fake-rclone');
  fs.writeFileSync(fake, FAKE_RCLONE, { mode: 0o755 });
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), CLIPFORGE_DATA: path.join(TMP, 'data'), CLIPFORGE_CLIPS: CLIPS, CLIPFORGE_RCLONE: fake },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await waitFor(() => fetch(`${BASE}/api/status`).then((r) => r.ok, () => false), 'server start');
});

after(() => {
  server?.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const t = (name, fn) => test(name, { skip: !REAL_RCLONE && 'rclone not available' }, fn);

test('parses rclone config steps and stats lines', () => {
  const step = parseConfigOutput('NOTICE: blah\n{"State":"s1","Option":{"Name":"config_type","Help":"Type ?","DefaultStr":"onedrive","Examples":[{"Value":"onedrive","Help":"OneDrive Personal"}],"IsPassword":false,"Exclusive":true,"Type":"string"},"Error":""}');
  assert.deepEqual(toQuestion(step), {
    state: 's1', name: 'config_type', help: 'Type ?', type: 'string', password: false, default: 'onedrive',
    examples: [{ value: 'onedrive', label: 'OneDrive Personal' }], exclusive: true, error: '',
  });
  assert.equal(parseConfigOutput(''), null);
  assert.deepEqual(parseStats('{"level":"notice","stats":{"bytes":50,"totalBytes":200,"transfers":1,"totalTransfers":3}}'),
    { progress: 0.25, transfers: 1, total: 3 });
  assert.equal(parseStats('not json'), null);
});

test('zip reader extracts stored and deflated entries', () => {
  const zipPath = path.join(TMP, 't.zip');
  execFileSync('python3', ['-c', `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w') as z:
    z.writestr('dir/stored.txt', 'bonjour', compress_type=zipfile.ZIP_STORED)
    z.writestr('dir/rclone', 'binaire ' * 1000, compress_type=zipfile.ZIP_DEFLATED)
`]);
  const buf = fs.readFileSync(zipPath);
  const entries = zipEntries(buf);
  assert.deepEqual(entries.map((e) => e.name), ['dir/stored.txt', 'dir/rclone']);
  assert.equal(extractEntry(buf, entries[0]).toString(), 'bonjour');
  assert.equal(extractEntry(buf, entries[1]).toString(), 'binaire '.repeat(1000));
  assert.throws(() => zipEntries(Buffer.from('pas un zip du tout, vraiment pas')), /ZIP invalide/);
});

t('a NAS folder source: browse, then sync recent videos only', async () => {
  const { body: src } = await post('/api/cloud/sources', { name: 'Mon NAS', type: 'local', params: { path: NAS } });
  assert.equal(src.status, 'ready');

  const { body: tree } = await api(`/api/cloud/sources/${src.id}/browse`);
  assert.deepEqual(tree.folders.map((f) => f.name), ['Street Fighter 6']);
  assert.equal(tree.videos, 2);

  await post(`/api/cloud/sources/${src.id}/sync`);
  const clips = await waitFor(async () => {
    const { body } = await api('/api/clips');
    return body.length >= 2 && body;
  }, 'synced clips');
  const games = clips.map((c) => c.game).sort();
  assert.deepEqual(games, ['Street Fighter 6', 'TEKKEN™8'], 'named from the file, or the folder below the source');
  assert.ok(!clips.some((c) => c.filename === 'vieux clip.mp4'), 'older than 30 days: skipped');
  assert.ok(fs.existsSync(path.join(CLIPS, 'Cloud', 'Mon NAS', 'Street Fighter 6', 'combo.mp4')));
  assert.ok(!fs.existsSync(path.join(CLIPS, 'Cloud', 'Mon NAS', 'notes.txt')));

  const { body: cloud } = await api('/api/cloud');
  const s = cloud.sources.find((x) => x.id === src.id);
  assert.equal(s.last_count, 2);
  assert.equal(s.last_error, null);

  // with no age limit, the old clip comes too
  await api(`/api/cloud/sources/${src.id}`, { method: 'PUT', body: JSON.stringify({ max_age_days: 0 }) });
  await post(`/api/cloud/sources/${src.id}/sync`);
  await waitFor(async () => (await api('/api/clips')).body.some((c) => c.filename === 'vieux clip.mp4'), 'old clip');
});

t('missing folder and missing fields are refused', async () => {
  assert.equal((await post('/api/cloud/sources', { type: 'local', params: { path: '/nope/nope' } })).status, 400);
  assert.equal((await post('/api/cloud/sources', { type: 'mega', params: { user: 'a@b.c' } })).status, 400);
  assert.equal((await post('/api/cloud/sources', { type: 'myspace' })).status, 400);
});

t('browser sign-in flow (Dropbox): link shown, then ready', async () => {
  const { body: src } = await post('/api/cloud/sources', { type: 'dropbox' });
  assert.equal(src.status, 'setup');
  const oauth = await waitFor(async () => {
    const { body } = await api(`/api/cloud/sources/${src.id}/setup`);
    return body.phase === 'oauth' && body;
  }, 'oauth link');
  assert.equal(oauth.url, 'http://127.0.0.1:53682/auth?state=abc');
  await waitFor(async () => (await api(`/api/cloud/sources/${src.id}/setup`)).body.phase === 'done', 'oauth done');
  assert.equal((await api('/api/cloud')).body.sources.find((s) => s.id === src.id).status, 'ready');
});

t('code-based flow (iCloud 2FA): wrong code asks again, right code finishes', async () => {
  const { body: src } = await post('/api/cloud/sources', {
    type: 'iclouddrive', params: { apple_id: 'moi@icloud.com', password: 'x', service: 'photos' },
  });
  const q = await waitFor(async () => {
    const { body } = await api(`/api/cloud/sources/${src.id}/setup`);
    return body.phase === 'question' && body.question;
  }, '2fa question');
  assert.equal(q.name, 'config_2fa');

  await post(`/api/cloud/sources/${src.id}/answer`, { state: q.state, value: '000000' });
  const again = await waitFor(async () => {
    const { body } = await api(`/api/cloud/sources/${src.id}/setup`);
    return body.phase === 'question' && body.question;
  }, 'retry question');
  assert.equal(again.error, 'Code invalide');

  await post(`/api/cloud/sources/${src.id}/answer`, { state: again.state, value: '123456' });
  await waitFor(async () => (await api(`/api/cloud/sources/${src.id}/setup`)).body.phase === 'done', '2fa done');

  await api(`/api/cloud/sources/${src.id}`, { method: 'DELETE' });
  assert.ok(!(await api('/api/cloud')).body.sources.some((s) => s.id === src.id));
});
