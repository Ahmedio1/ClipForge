import fs from 'node:fs';
import path from 'node:path';
import { getConfig, THUMBS_DIR } from './config.js';
import { db } from './db.js';
import { probe, thumbnail } from './media.js';
import { parseCaptureName } from './naming.js';

export { parseCaptureName };

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi']);
const UNKNOWN_GAME = 'Sans jeu';

const pad = (n) => String(n).padStart(2, '0');

function localIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

export const thumbPath = (id) => path.join(THUMBS_DIR, `${id}.jpg`);

const findByPath = db.prepare('SELECT id, size, missing FROM clips WHERE path = ?');
const insertClip = db.prepare(`
  INSERT INTO clips (path, filename, game, recorded_at, duration, width, height, has_audio, size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const updateProbe = db.prepare(`
  UPDATE clips SET duration = ?, width = ?, height = ?, has_audio = ?, size = ?, missing = 0 WHERE id = ?`);

export const state = { scanning: false, version: 0, lastScan: null, lastError: null };

/** Removes from the library (rows + thumbnails) every clip stored under `dir`. Files are untouched. */
export function forgetClipsUnder(dir) {
  const prefix = path.resolve(dir) + path.sep;
  const rows = db.prepare('SELECT id, path FROM clips').all().filter((r) => r.path.startsWith(prefix));
  const del = db.prepare('DELETE FROM clips WHERE id = ?');
  for (const r of rows) {
    del.run(r.id);
    fs.rmSync(thumbPath(r.id), { force: true });
  }
  if (rows.length) state.version++;
  return rows.length;
}

/** Number and total size of the library clips stored under `dir`. */
export function clipsUnder(dir) {
  const prefix = path.resolve(dir) + path.sep;
  const rows = db.prepare('SELECT path, size FROM clips WHERE missing = 0').all().filter((r) => r.path.startsWith(prefix));
  return { count: rows.length, bytes: rows.reduce((t, r) => t + r.size, 0) };
}

async function addOrRefresh(file, clipsDir) {
  const stat = fs.statSync(file);
  // Game Bar / OBS may still be writing this file; the next scan will pick it up.
  if (Date.now() - stat.mtimeMs < 4000) return 'busy';

  const existing = findByPath.get(file);
  if (existing && existing.size === stat.size) {
    if (existing.missing) {
      db.prepare('UPDATE clips SET missing = 0 WHERE id = ?').run(existing.id);
      return 'changed';
    }
    return 'same';
  }

  const meta = await probe(file);
  // Thumbnail first, so a clip never shows up in the library without one.
  const tmpThumb = path.join(THUMBS_DIR, `tmp-${process.pid}-${Date.now()}.jpg`);
  await thumbnail(file, tmpThumb, Math.min(meta.duration * 0.3, 5));
  let id = existing?.id;
  if (id) {
    fs.renameSync(tmpThumb, thumbPath(id));
    updateProbe.run(meta.duration, meta.width, meta.height, meta.hasAudio ? 1 : 0, stat.size, id);
  } else {
    const parsed = parseCaptureName(path.basename(file));
    const relDir = path.relative(clipsDir, path.dirname(file));
    // the first folder names the game, except ClipForge's own folders: Imports/ and
    // Cloud/<source>/ (there, the folder below the source's one does)
    const parts = relDir && !relDir.startsWith('..') ? relDir.split(path.sep) : [];
    const folderGame = parts[0] === 'Cloud' ? (parts[2] ?? null) : parts[0] === 'Imports' ? null : (parts[0] ?? null);
    const game = parsed.game || folderGame || UNKNOWN_GAME;
    db.exec('BEGIN');
    try {
      id = Number(insertClip.run(
        file, path.basename(file), game, parsed.recordedAt || localIso(stat.mtime),
        meta.duration, meta.width, meta.height, meta.hasAudio ? 1 : 0, stat.size,
      ).lastInsertRowid);
      fs.renameSync(tmpThumb, thumbPath(id));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      fs.rmSync(tmpThumb, { force: true });
      throw err;
    }
  }
  return 'changed';
}

async function doScan() {
  const { clipsDir } = getConfig();
  const seen = new Set();
  let changed = false;
  let busy = false;

  for (const file of walk(clipsDir)) {
    seen.add(file);
    try {
      const result = await addOrRefresh(file, clipsDir);
      if (result === 'changed') {
        changed = true;
        state.version++; // let the UI show clips as they arrive
      }
      if (result === 'busy') busy = true;
    } catch (err) {
      console.warn(`[scan] ignoré ${file}: ${err.message}`);
    }
  }

  const markMissing = db.prepare('UPDATE clips SET missing = 1 WHERE id = ?');
  for (const row of db.prepare('SELECT id, path FROM clips WHERE missing = 0').all()) {
    if (!seen.has(row.path) && !fs.existsSync(row.path)) {
      markMissing.run(row.id);
      changed = true;
    }
  }

  if (changed) state.version++;
  if (busy) setTimeout(scan, 5000);
}

let running = null;
let again = false;

export function scan() {
  if (running) {
    again = true;
    return running;
  }
  state.scanning = true;
  running = doScan()
    .catch((err) => {
      state.lastError = err.message;
      console.error('[scan]', err);
    })
    .finally(() => {
      running = null;
      state.scanning = false;
      state.lastScan = new Date().toISOString();
      if (again) {
        again = false;
        scan();
      }
    });
  return running;
}

let watcher = null;
let debounce = null;

export function watchClipsDir() {
  watcher?.close();
  const { clipsDir } = getConfig();
  try {
    watcher = fs.watch(clipsDir, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 1500);
    });
  } catch (err) {
    console.warn('[watch] surveillance impossible, scan périodique uniquement:', err.message);
  }
}
