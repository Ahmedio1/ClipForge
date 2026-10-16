import { spawn } from 'node:child_process';
import { ffmpegPath, run } from './media.js';

const WINDOW = 0.25; // seconds per analysis bin

/** Decodes audio to mono 8 kHz floats and returns loudness (dB RMS) per WINDOW. */
async function audioLoudness(file) {
  const raw = await runBuffer(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const per = 8000 * WINDOW;
  const out = [];
  for (let i = 0; i + per <= samples.length; i += per) {
    let sum = 0;
    for (let j = i; j < i + per; j++) sum += samples[j] * samples[j];
    out.push(10 * Math.log10(sum / per + 1e-10));
  }
  return out;
}

/** For silent clips: how much the picture changes per WINDOW (0..1). */
async function sceneChanges(file) {
  const out = await run(ffmpegPath, [
    '-v', 'error', '-i', file, '-an',
    '-vf', `fps=${1 / WINDOW},scale=160:-2,select='gte(scene,0)',metadata=print:file=-`, '-f', 'null', '-',
  ]);
  return [...out.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((m) => Number(m[1]));
}

export function runBuffer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function smooth(values, radius) {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

/**
 * Picks the most intense moments from an excitement curve (one value per WINDOW).
 * Game action usually builds up before the loudest instant (the kill, the goal), so each
 * window leans backwards: `before` seconds before the peak, `after` seconds after.
 */
export function pickHighlights(curve, duration, { max = 5, minGap = 6, before = 4, after = 2, minScore = 0.25 } = {}) {
  if (!curve.length) return [];
  const lo = Math.min(...curve);
  const hi = Math.max(...curve);
  if (hi - lo < 1e-6) return [];
  const norm = curve.map((v) => (v - lo) / (hi - lo));
  const order = norm.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const [score, i] of order) {
    if (picked.length >= max || score < minScore) break;
    const time = (i + 0.5) * WINDOW;
    if (picked.some((p) => Math.abs(p.time - time) < minGap)) continue;
    picked.push({
      time: round(time),
      score: round(score),
      start: round(Math.max(0, time - before)),
      end: round(Math.min(duration, time + after)),
    });
  }
  return picked;
}

const round = (n) => Math.round(n * 100) / 100;

/** Returns { highlights, curve } where curve is ≤200 points of 0..1 intensity for drawing. */
export async function analyzeClip(clip) {
  let curve;
  if (clip.has_audio) {
    const db = await audioLoudness(clip.path);
    const floor = median(db);
    // Excitement = how far above the clip's own typical level, so quiet and loud recordings compare.
    curve = smooth(db.map((v) => Math.max(0, v - floor)), 2);
  } else {
    curve = smooth(await sceneChanges(clip.path), 3);
  }
  const highlights = pickHighlights(curve, clip.duration);

  const step = Math.max(1, Math.ceil(curve.length / 200));
  const peak = Math.max(...curve, 1e-6);
  const preview = [];
  for (let i = 0; i < curve.length; i += step) {
    preview.push(round(Math.max(...curve.slice(i, i + step)) / peak));
  }
  return { highlights, curve: preview, source: clip.has_audio ? 'audio' : 'video' };
}
