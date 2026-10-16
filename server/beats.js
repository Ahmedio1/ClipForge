// Finds the beat of a music track, so montage cuts can land on it.
import fs from 'node:fs';
import { runBuffer } from './highlights.js';

const SR = 11025;
const HOP = 256; // ~23 ms per onset value

/** Onset strength per hop: how much the (log) energy jumps up, kick drums weighted in. */
export function onsetEnvelope(samples) {
  const out = [];
  let prev = 0;
  for (let i = 0; i + HOP <= samples.length; i += HOP) {
    let e = 0;
    for (let j = i; j < i + HOP; j++) e += samples[j] * samples[j];
    const loud = Math.log10(e / HOP + 1e-9);
    out.push(Math.max(0, loud - prev));
    prev = loud;
  }
  return out;
}

const combScore = (env, period, phase) => {
  let s = 0;
  let n = 0;
  for (let x = phase; x < env.length - 1; x += period) {
    const i = Math.floor(x);
    const f = x - i;
    s += env[i] * (1 - f) + env[i + 1] * f;
    n++;
  }
  return n ? s / n : 0;
};

/**
 * Tempo and beat times (seconds) from an onset envelope: autocorrelation picks the period
 * (70–180 BPM, leaning towards ~120), then a comb search refines it and finds the phase.
 */
export function beatsFromEnvelope(env, { hopSec = HOP / SR } = {}) {
  if (env.length < 64) return { bpm: 0, beats: [] };
  const m = env.reduce((a, b) => a + b, 0) / env.length;
  const x = env.map((v) => v - m);
  const minLag = Math.floor(60 / 180 / hopSec);
  const maxLag = Math.ceil(60 / 70 / hopSec);
  let best = { lag: 0, score: -Infinity };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    const bpm = 60 / (lag * hopSec);
    s *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s > best.score) best = { lag, score: s };
  }
  if (best.score <= 0) return { bpm: 0, beats: [] };

  let period = best.lag;
  let phase = 0;
  let top = -Infinity;
  for (let p = best.lag - 1; p <= best.lag + 1; p += 0.02) {
    for (let ph = 0; ph < p; ph += 0.5) {
      const s = combScore(env, p, ph);
      if (s > top) [top, period, phase] = [s, p, ph];
    }
  }
  const beats = [];
  for (let t = phase; t < env.length; t += period) beats.push(Number((t * hopSec).toFixed(3)));
  return { bpm: Number((60 / (period * hopSec)).toFixed(1)), beats };
}

const cache = new Map();

/** Beat analysis of an audio file, cached per path and modification time. */
export async function musicBeats(file) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!cache.has(key)) {
    const raw = await runBuffer(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    cache.set(key, beatsFromEnvelope(onsetEnvelope(samples)));
  }
  return cache.get(key);
}

/** The beats of a looping track, repeated until `total` seconds. */
export function loopBeats(beats, musicDuration, total) {
  if (!beats.length || !(musicDuration > 0)) return [];
  const out = [];
  for (let k = 0; k * musicDuration < total; k++) {
    for (const b of beats) {
      const t = k * musicDuration + b;
      if (b < musicDuration && t <= total) out.push(t);
    }
  }
  return out;
}
