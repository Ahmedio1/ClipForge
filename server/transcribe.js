import path from 'node:path';
import { DATA_DIR } from './config.js';
import { runBuffer } from './highlights.js';
import { mutex } from './jobs.js';

export { groupCaptions } from './captions.js';

export const MODELS = {
  fast: 'onnx-community/whisper-base_timestamped',
  accurate: 'onnx-community/whisper-small_timestamped',
};
export const LANGUAGES = ['french', 'english', 'spanish', 'german', 'italian', 'portuguese', 'arabic'];

const MODELS_DIR = process.env.CLIPFORGE_MODELS || path.join(DATA_DIR, 'models');
const pipelines = new Map();
const exclusive = mutex();

async function getPipeline(quality, onStatus) {
  const id = MODELS[quality] || MODELS.fast;
  if (!pipelines.has(id)) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = MODELS_DIR;
    const files = new Map();
    pipelines.set(id, pipeline('automatic-speech-recognition', id, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, [p.loaded, p.total]);
        const [loaded, total] = [...files.values()].reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
        onStatus?.(`Téléchargement du modèle de voix (une seule fois)… ${Math.round((loaded / total) * 100)} %`);
      },
    }).catch((err) => {
      pipelines.delete(id);
      throw new Error(`Modèle de reconnaissance vocale indisponible : ${err.message}`);
    }));
  }
  return pipelines.get(id);
}

/** Transcribes [start, start+duration] of a media file. Word times are relative to `start`. */
export function transcribe(file, { start = 0, duration, language = 'french', quality = 'fast', onStatus } = {}) {
  return exclusive(async () => {
    const asr = await getPipeline(quality, onStatus);
    const args = ['-v', 'error', '-ss', String(start)];
    if (duration) args.push('-t', String(duration));
    args.push('-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-');
    const raw = await runBuffer(args);
    const audio = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    if (audio.length < 16000 * 0.3) return [];
    onStatus?.('Transcription…');
    const out = await asr(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      language: LANGUAGES.includes(language) ? language : 'french',
      task: 'transcribe',
    });
    return (out.chunks || [])
      .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.text);
  });
}
