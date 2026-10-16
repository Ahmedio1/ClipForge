import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(path.join(DATA_DIR, 'clipforge.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT NOT NULL UNIQUE,
    filename    TEXT NOT NULL,
    title       TEXT,
    game        TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    duration    REAL NOT NULL,
    width       INTEGER,
    height      INTEGER,
    has_audio   INTEGER NOT NULL DEFAULT 1,
    size        INTEGER NOT NULL,
    favorite    INTEGER NOT NULL DEFAULT 0,
    tags        TEXT NOT NULL DEFAULT '',
    missing     INTEGER NOT NULL DEFAULT 0,
    added_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id     INTEGER REFERENCES clips(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    progress    REAL NOT NULL DEFAULT 0,
    options     TEXT NOT NULL,
    out_path    TEXT,
    size        INTEGER,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS publications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    export_id   INTEGER REFERENCES exports(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
    progress    REAL NOT NULL DEFAULT 0,
    meta        TEXT NOT NULL,
    remote_id   TEXT,
    url         TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const clipCols = db.prepare('PRAGMA table_info(clips)').all().map((c) => c.name);
if (!clipCols.includes('analysis')) {
  db.exec('ALTER TABLE clips ADD COLUMN analysis TEXT'); // cached highlight detection (JSON)
}

const exportCols = db.prepare('PRAGMA table_info(exports)').all().map((c) => c.name);
if (!exportCols.includes('project_id')) {
  db.exec('ALTER TABLE exports ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL');
}

// An export interrupted by a server stop can't resume.
db.prepare(`UPDATE exports SET status = 'failed', error = 'Interrompu (serveur arrêté)'
            WHERE status IN ('queued', 'running')`).run();
db.prepare(`UPDATE publications SET status = 'failed', error = 'Interrompu (serveur arrêté)'
            WHERE status IN ('queued', 'running')`).run();
