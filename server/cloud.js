// Cloud sources through rclone: one integration for OneDrive, Google Drive, Dropbox, iCloud,
// Mega, NAS (SMB) and plain folders. New videos are copied into <clipsDir>/Cloud/<source>,
// where the library scanner picks them up like any other clip.
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { db } from './db.js';
import { extractEntry, zipEntries } from './unzip.js';
import { clipsUnder, forgetClipsUnder } from './library.js';
import { parseConfigOutput, parseStats, toQuestion } from './rclone-output.js';

const RCLONE_VERSION = 'v1.75.2';
const BIN_DIR = path.join(DATA_DIR, 'bin');
const RCLONE_CONF = path.join(DATA_DIR, 'rclone.conf');
export const VIDEO_GLOB = '*.{mp4,MP4,mkv,MKV,mov,MOV,webm,WEBM,m4v,M4V}';

/** What the add-source form asks for each provider; OAuth ones authenticate in the browser. */
export const PROVIDERS = {
  onedrive: { label: 'OneDrive', oauth: true, fields: [] },
  drive: {
    label: 'Google Drive',
    oauth: true,
    // rclone's shared Google client is being retired in 2026: the same Google Cloud
    // "desktop app" client used for YouTube works here (enable the Drive API on it).
    fields: [
      { key: 'client_id', label: 'ID client Google (optionnel)', optional: true },
      { key: 'client_secret', label: 'Code secret du client (optionnel)', optional: true, password: true },
    ],
    params: { scope: 'drive.readonly' },
  },
  dropbox: { label: 'Dropbox', oauth: true, fields: [] },
  iclouddrive: {
    label: 'iCloud (Drive ou Photos)',
    fields: [
      { key: 'apple_id', label: 'Identifiant Apple' },
      { key: 'password', label: 'Mot de passe Apple', password: true },
      { key: 'service', label: 'Service', choices: [['photos', 'Photos (vidéos de l’iPhone)'], ['drive', 'iCloud Drive']] },
    ],
  },
  mega: {
    label: 'Mega',
    fields: [{ key: 'user', label: 'E-mail Mega' }, { key: 'pass', label: 'Mot de passe', password: true }],
  },
  smb: {
    label: 'NAS / PC Windows (partage réseau)',
    fields: [
      { key: 'host', label: 'Adresse (ex. 192.168.1.20 ou nas.local)' },
      { key: 'user', label: 'Utilisateur', optional: true },
      { key: 'pass', label: 'Mot de passe', optional: true, password: true },
    ],
  },
  local: {
    label: 'Dossier de ce PC (NAS monté, disque externe…)',
    fields: [{ key: 'path', label: 'Chemin du dossier (ex. /mnt/nas/Clips)' }],
  },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,
    remote        TEXT NOT NULL UNIQUE,
    folder        TEXT NOT NULL DEFAULT '',
    max_age_days  INTEGER NOT NULL DEFAULT 30,
    interval_min  INTEGER NOT NULL DEFAULT 15,
    status        TEXT NOT NULL DEFAULT 'setup', -- setup | ready | error
    last_sync     TEXT,
    last_count    INTEGER,
    last_error    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Folder under <clips>/Cloud, fixed at creation so renaming a source doesn't orphan its videos.
if (!db.prepare('PRAGMA table_info(cloud_sources)').all().some((c) => c.name === 'dest')) {
  db.exec('ALTER TABLE cloud_sources ADD COLUMN dest TEXT');
}

// ---- rclone binary ------------------------------------------------------------------

let rcloneBin = null;

function findSystemRclone() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rclone'], { stdio: 'pipe' });
    return 'rclone';
  } catch {
    return null;
  }
}

/** Uses CLIPFORGE_RCLONE, a system rclone, or downloads the official build (checksum-verified). */
export async function ensureRclone(onStatus) {
  if (rcloneBin) return rcloneBin;
  if (process.env.CLIPFORGE_RCLONE) return (rcloneBin = process.env.CLIPFORGE_RCLONE);
  const local = path.join(BIN_DIR, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
  if (fs.existsSync(local)) return (rcloneBin = local);
  const system = findSystemRclone();
  if (system) return (rcloneBin = system);

  const os = { linux: 'linux', darwin: 'osx', win32: 'windows' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error(`Plateforme non gérée par rclone : ${process.platform}/${process.arch}`);
  const file = `rclone-${RCLONE_VERSION}-${os}-${arch}.zip`;
  const base = `https://downloads.rclone.org/${RCLONE_VERSION}`;
  onStatus?.('Téléchargement de rclone (≈ 25 Mo, une seule fois)…');
  const [zipRes, sumsRes] = await Promise.all([fetch(`${base}/${file}`), fetch(`${base}/SHA256SUMS`)]);
  if (!zipRes.ok || !sumsRes.ok) throw new Error('Téléchargement de rclone impossible');
  const zip = Buffer.from(await zipRes.arrayBuffer());
  const expected = (await sumsRes.text()).split('\n').find((l) => l.trim().endsWith(file))?.split(/\s+/)[0];
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (!expected || expected !== actual) throw new Error('Somme de contrôle de rclone invalide, téléchargement refusé');
  const entry = zipEntries(zip).find((e) => /\/rclone(\.exe)?$/.test(e.name));
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(local, extractEntry(zip, entry), { mode: 0o755 });
  return (rcloneBin = local);
}

function rclone(args, { onStderr, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBin, ['--config', RCLONE_CONF, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => {
      stderr = (stderr + c).slice(-20_000);
      onStderr?.(c.toString());
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---- adding a source: rclone's config state machine ----------------------------------------

const getSource = db.prepare('SELECT * FROM cloud_sources WHERE id = ?');
const setups = new Map(); // id → { phase: 'working'|'question'|'oauth'|'done'|'error', question, url, error }

async function handleStep(id, result) {
  if (result.code !== 0 && !result.stdout.includes('{')) {
    const msg = result.stderr.trim().split('\n').filter((l) => !/^Usage:|^\s/.test(l)).at(-1) || `rclone ${result.code}`;
    throw new Error(msg.replace(/^.*?(ERROR|Error|CRITICAL)\s*:?\s*/, ''));
  }
  const step = parseConfigOutput(result.stdout);
  if (!step || !step.State) {
    db.prepare(`UPDATE cloud_sources SET status = 'ready', last_error = NULL WHERE id = ?`).run(id);
    setups.set(id, { phase: 'done' });
    return;
  }
  // Same machine as the browser: answer "yes" and let rclone run its local OAuth page.
  if (step.Option?.Name === 'config_is_local') return answer(id, step.State, 'true');
  setups.set(id, { phase: 'question', question: toQuestion(step) });
}

function fail(id, err) {
  db.prepare(`UPDATE cloud_sources SET status = 'error', last_error = ? WHERE id = ?`).run(err.message, id);
  setups.set(id, { phase: 'error', error: err.message });
}

export async function createSource({ name, type, params = {} }) {
  const provider = PROVIDERS[type];
  if (!provider) throw new Error('Service inconnu');
  for (const f of provider.fields) {
    if (!f.optional && !String(params[f.key] ?? '').trim()) throw new Error(`${f.label} : requis`);
  }
  await ensureRclone();
  const label = String(name || '').trim() || provider.label;
  // interval 0: by default the user picks which videos to import
  const info = db.prepare('INSERT INTO cloud_sources (name, type, remote, interval_min) VALUES (?, ?, ?, 0)')
    .run(label.slice(0, 60), type, `tmp-${crypto.randomUUID()}`);
  const id = Number(info.lastInsertRowid);
  const taken = new Set(db.prepare('SELECT dest FROM cloud_sources WHERE dest IS NOT NULL').all().map((r) => r.dest));
  let dest = safeDir(label);
  if (taken.has(dest) || fs.existsSync(path.join(getConfig().clipsDir, 'Cloud', dest))) dest = `${dest} (${id})`;
  db.prepare('UPDATE cloud_sources SET dest = ? WHERE id = ?').run(dest, id);
  const remote = `cf${id}`;
  db.prepare('UPDATE cloud_sources SET remote = ? WHERE id = ?').run(remote, id);

  const kv = { ...provider.params };
  for (const f of provider.fields) if (String(params[f.key] ?? '').trim()) kv[f.key] = String(params[f.key]).trim();
  if (type === 'local') {
    // a local "remote" is just the folder; nothing to configure in rclone
    if (!fs.existsSync(kv.path)) {
      db.prepare('DELETE FROM cloud_sources WHERE id = ?').run(id);
      throw new Error(`Dossier introuvable : ${kv.path}`);
    }
    db.prepare(`UPDATE cloud_sources SET status = 'ready', folder = ? WHERE id = ?`).run(kv.path, id);
    setups.set(id, { phase: 'done' });
    return getSource.get(id);
  }

  setups.set(id, { phase: 'working' });
  const args = ['config', 'create', remote, type, ...Object.entries(kv).map(([k, v]) => `${k}=${v}`), '--non-interactive'];
  rclone(args).then((r) => handleStep(id, r)).catch((err) => fail(id, err));
  return getSource.get(id);
}

export function answer(id, state, value) {
  const src = getSource.get(id);
  if (!src) throw new Error('Source inconnue');
  setups.set(id, { phase: 'working' });
  const args = ['config', 'update', src.remote, '--continue', '--state', state, '--result', String(value), '--non-interactive'];
  rclone(args, {
    onStderr: (text) => {
      const url = text.match(/go to the following link: (\S+)/)?.[1];
      if (url) setups.set(id, { phase: 'oauth', url });
    },
  }).then((r) => handleStep(id, r)).catch((err) => fail(id, err));
}

export function setupStatus(id) {
  const src = getSource.get(id);
  if (!src) return null;
  return setups.get(id) || (src.status === 'ready' ? { phase: 'done' } : { phase: 'error', error: src.last_error || 'Configuration interrompue, recommence' });
}

// ---- browsing & syncing ---------------------------------------------------------------

/** rclone path for a source and a sub-folder ("local" sources are plain paths). */
function remotePath(src, sub = '') {
  if (src.type === 'local') return path.join(src.folder, sub);
  return `${src.remote}:${sub}`;
}

/** A browse path (relative to the source root) → its place under the source's local folder. */
function localRel(src, p) {
  if (src.type === 'local') return p;
  return src.folder && p.startsWith(`${src.folder}/`) ? p.slice(src.folder.length + 1) : p;
}

export async function browse(id, sub = '') {
  const src = getSource.get(id);
  if (!src) throw new Error('Source inconnue');
  await ensureRclone();
  const { code, stdout, stderr } = await rclone(['lsjson', remotePath(src, sub), '--max-depth', '1']);
  if (code !== 0) throw new Error(stderr.trim().split('\n').at(-1) || 'Lecture impossible');
  const items = JSON.parse(stdout || '[]');
  const isVideo = (n) => /\.(mp4|mkv|mov|webm|m4v)$/i.test(n);
  const join = (name) => (sub ? `${sub}/${name}` : name);
  const dest = destFor(src);
  return {
    folders: items.filter((i) => i.IsDir).map((i) => ({ name: i.Name, path: join(i.Name) })),
    videos: items.filter((i) => !i.IsDir && isVideo(i.Name))
      .map((i) => ({
        name: i.Name, path: join(i.Name), size: i.Size, modTime: i.ModTime,
        imported: fs.existsSync(path.join(dest, localRel(src, join(i.Name)))),
      }))
      .sort((a, b) => b.modTime.localeCompare(a.modTime)),
  };
}

/** Copies the chosen videos (browse paths) into the library, one by one. */
export async function importVideos(id, paths) {
  const src = getSource.get(id);
  if (!src || src.status !== 'ready') throw new Error('Source pas prête');
  if (syncing.has(id)) throw new Error('Un import est déjà en cours pour cette source');
  const clean = [...new Set(paths.map(String))].filter((p) => p && !p.split('/').includes('..'));
  if (!clean.length) throw new Error('Aucune vidéo choisie');
  await ensureRclone();
  const dest = destFor(src);
  syncing.set(id, { progress: 0, message: `Import 0/${clean.length}…` });
  let done = 0;
  const errors = [];
  try {
    for (const p of clean) {
      const target = path.join(dest, localRel(src, p));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const { code, stderr } = await rclone(['copyto', remotePath(src, p), target, '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'], {
        onStderr: (text) => {
          for (const line of text.split('\n')) {
            const st = parseStats(line);
            if (st) syncing.set(id, { progress: (done + st.progress) / clean.length, message: `Import ${done + 1}/${clean.length} : ${path.basename(p)}` });
          }
        },
      });
      if (code === 0) done++;
      else errors.push(`${path.basename(p)} : ${stderr.trim().split('\n').at(-1)}`);
    }
    db.prepare(`UPDATE cloud_sources SET last_sync = datetime('now'), last_count = ?, last_error = ? WHERE id = ?`)
      .run(done, errors.length ? errors.join(' · ').slice(0, 500) : null, id);
    return { imported: done, errors };
  } finally {
    syncing.delete(id);
  }
}

const safeDir = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w .-]+/g, '_').trim() || 'Source';
export const destFor = (src) => path.join(getConfig().clipsDir, 'Cloud', src.dest || safeDir(src.name));

const syncing = new Map(); // id → { progress, message }

export function syncState(id) {
  return syncing.get(id) || null;
}

export async function syncSource(id) {
  const src = getSource.get(id);
  if (!src || src.status !== 'ready' || syncing.has(id)) return;
  syncing.set(id, { progress: 0, message: 'Recherche des nouvelles vidéos…' });
  try {
    await ensureRclone();
    const dest = destFor(src);
    fs.mkdirSync(dest, { recursive: true });
    let last = { transfers: 0, total: 0 };
    const from = src.type === 'local' ? src.folder : remotePath(src, src.folder);
    const args = ['copy', from, dest, '--include', VIDEO_GLOB, '--use-json-log', '-v', '--stats', '1s', '--stats-log-level', 'NOTICE'];
    if (src.max_age_days > 0) args.push('--max-age', `${src.max_age_days}d`);
    let buffer = '';
    const { code, stderr } = await rclone(args, {
      onStderr: (text) => {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const s = parseStats(line);
          if (!s) continue;
          last = s;
          syncing.set(id, {
            progress: s.progress,
            message: s.total ? `${s.transfers}/${s.total} vidéo(s) récupérée(s)` : 'Recherche des nouvelles vidéos…',
          });
        }
      },
    });
    if (code !== 0) throw new Error(stderr.trim().split('\n').map((l) => { try { return JSON.parse(l).msg; } catch { return l; } }).at(-1));
    db.prepare(`UPDATE cloud_sources SET last_sync = datetime('now'), last_count = ?, last_error = NULL WHERE id = ?`)
      .run(last.transfers, id);
  } catch (err) {
    db.prepare(`UPDATE cloud_sources SET last_sync = datetime('now'), last_error = ? WHERE id = ?`).run(err.message, id);
  } finally {
    syncing.delete(id);
  }
}

export function listSources() {
  return db.prepare('SELECT * FROM cloud_sources ORDER BY id').all().map((s) => ({
    ...s, dest: destFor(s), local: clipsUnder(destFor(s)), syncing: syncState(s.id), setup: s.status === 'setup' ? setupStatus(s.id) : null,
  }));
}

/**
 * Removes a source. With `deleteVideos`, its imported copies are deleted too (files, library
 * entries, thumbnails); nothing is ever deleted on the cloud service itself.
 */
export async function deleteSource(id, { deleteVideos = false } = {}) {
  const src = getSource.get(id);
  if (!src) return { deleted: 0 };
  if (syncing.has(id)) throw new Error('Import en cours, attends la fin');
  let deleted = 0;
  if (deleteVideos) {
    const dest = destFor(src);
    const cloudRoot = path.join(getConfig().clipsDir, 'Cloud') + path.sep;
    // never delete outside <clips>/Cloud/
    if (!path.resolve(dest).startsWith(cloudRoot)) throw new Error('Dossier inattendu, suppression annulée');
    deleted = forgetClipsUnder(dest);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  if (src.type !== 'local' && rcloneBin) await rclone(['config', 'delete', src.remote]).catch(() => {});
  db.prepare('DELETE FROM cloud_sources WHERE id = ?').run(id);
  setups.delete(id);
  return { deleted };
}

/** Every minute, syncs the sources whose interval has elapsed. */
export function startScheduler() {
  const tick = () => {
    const due = db.prepare(`
      SELECT id FROM cloud_sources
      WHERE status = 'ready' AND interval_min > 0
        AND (last_sync IS NULL OR last_sync <= datetime('now', '-' || interval_min || ' minutes'))`).all();
    for (const { id } of due) syncSource(id);
  };
  setTimeout(tick, 5000);
  return setInterval(tick, 60_000);
}
