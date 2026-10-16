// Finds where the characters are, so vertical exports can follow them instead of cropping blindly.
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { runBuffer } from './highlights.js';
import { mutex } from './jobs.js';
import { fightersBox } from './camera.js';

const MODEL = 'Xenova/yolos-tiny';
const MODELS_DIR = process.env.CLIPFORGE_MODELS || path.join(DATA_DIR, 'models');
const FRAME_W = 640;
const FRAME_H = 360;

db.exec(`
  CREATE TABLE IF NOT EXISTS clip_tracks (
    clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    sec     INTEGER NOT NULL,
    box     TEXT,            -- normalized [x0, y0, x1, y1] of all characters, or null
    PRIMARY KEY (clip_id, sec)
  );
`);

let detector = null;
const exclusive = mutex();

async function getDetector() {
  if (!detector) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = MODELS_DIR;
    detector = pipeline('object-detection', MODEL, { dtype: 'q8' }).catch((err) => {
      detector = null;
      throw new Error(`Détecteur de personnages indisponible : ${err.message}`);
    });
  }
  return detector;
}

/** Detects characters once per second over [start, end] of a clip, using/filling the cache. */
export function trackClip(clip, start, end, onStatus) {
  return exclusive(async () => {
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(Math.floor(clip.duration), Math.ceil(end));
    const cached = new Map(db.prepare('SELECT sec, box FROM clip_tracks WHERE clip_id = ? AND sec BETWEEN ? AND ?')
      .all(clip.id, first, last).map((r) => [r.sec, r.box ? JSON.parse(r.box) : null]));
    const missing = [];
    for (let s = first; s <= last; s++) if (!cached.has(s)) missing.push(s);

    if (missing.length) {
      const det = await getDetector();
      const { RawImage } = await import('@huggingface/transformers');
      const save = db.prepare('INSERT OR REPLACE INTO clip_tracks (clip_id, sec, box) VALUES (?, ?, ?)');
      // one ffmpeg pass over the missing span, one frame per second
      const from = missing[0];
      const to = missing.at(-1);
      const raw = await runBuffer([
        '-v', 'error', '-ss', String(from), '-i', clip.path, '-t', String(to - from + 1), '-an',
        '-vf', `fps=1,scale=${FRAME_W}:${FRAME_H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ]);
      const frameBytes = FRAME_W * FRAME_H * 3;
      const frames = Math.floor(raw.length / frameBytes);
      for (let i = 0; i < frames; i++) {
        const sec = from + i;
        if (cached.has(sec)) continue;
        onStatus?.(`Repérage des personnages… ${i + 1}/${frames}`);
        const img = new RawImage(new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes), FRAME_W, FRAME_H, 3);
        const out = await det(img, { threshold: 0.5 });
        const box = fightersBox(out.map((o) => ({
          label: o.label,
          score: o.score,
          box: { x0: o.box.xmin / FRAME_W, y0: o.box.ymin / FRAME_H, x1: o.box.xmax / FRAME_W, y1: o.box.ymax / FRAME_H },
        })));
        cached.set(sec, box);
        save.run(clip.id, sec, box ? JSON.stringify(box) : null);
      }
    }
    return [...cached.entries()].sort((a, b) => a[0] - b[0]).map(([sec, box]) => ({ sec, box }));
  });
}
