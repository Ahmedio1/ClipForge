import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, EXPORTS_DIR, MUSIC_DIR } from './config.js';
import { db } from './db.js';
import { exportVideo, probeDuration, runFfmpeg } from './media.js';
import { buildMontageArgs, planTimeline, sanitizeProjectData } from './montage.js';
import { planCamera } from './camera.js';
import { trackClip } from './tracking.js';

const setStatus = db.prepare('UPDATE exports SET status = ?, error = ? WHERE id = ?');
const setProgress = db.prepare('UPDATE exports SET progress = ? WHERE id = ?');
const setDone = db.prepare(`UPDATE exports SET status = 'done', progress = 1, out_path = ?, size = ? WHERE id = ?`);
const insertExport = db.prepare('INSERT INTO exports (clip_id, project_id, name, options) VALUES (?, ?, ?, ?)');

const FORMAT_LABEL = {
  original: 'original', 'vertical-blur': '9:16 flou', 'vertical-crop': '9:16 recadré', 'vertical-fight': '9:16 combat',
};

const queue = [];
let busy = false;

function safeName(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'clip';
}

function enqueue({ clipId = null, projectId = null, name, options, label, render }) {
  const id = Number(insertExport.run(clipId, projectId, name, JSON.stringify(options)).lastInsertRowid);
  queue.push({ id, label, render });
  pump();
  return id;
}

export function enqueueExport(clip, options) {
  const label = options.title?.trim() || clip.title || clip.game;
  if (options.format === 'vertical-fight') {
    // rendered as a one-clip montage, which is where the fight layout lives
    const data = sanitizeProjectData({
      format: 'vertical', fit: 'fight', fps: 60, transition: 'none', fadeInOut: false,
      gameVolume: options.mute ? 0 : 1, segments: [{ clipId: clip.id, start: options.start, end: options.end }],
    });
    return enqueue({
      clipId: clip.id,
      name: `${label} – ${FORMAT_LABEL[options.format]}`,
      options,
      label,
      render: renderMontage(data, new Map([[clip.id, clip]])),
    });
  }
  return enqueue({
    clipId: clip.id,
    name: `${label} – ${FORMAT_LABEL[options.format]}`,
    options,
    label,
    render: (output, onProgress) => exportVideo(
      { input: clip.path, output, hasAudio: !!clip.has_audio, ...options }, onProgress),
  });
}

/** `clipsById` must already contain every clip the project references. */
export function enqueueMontage(project, data, clipsById) {
  const label = project.name;
  return enqueue({
    projectId: project.id,
    name: `${label} – montage ${data.format === 'vertical' ? '9:16' : '16:9'}`,
    options: { montage: true, format: data.format, segments: data.segments.length },
    label,
    render: renderMontage(data, clipsById),
  });
}

/** Character tracking for the fight layout, reported as the first 30 % of progress. */
async function cameraPlans(data, clipsById, onProgress) {
  const cameras = new Map();
  if (data.fit !== 'fight' || data.format !== 'vertical') return { cameras, weight: 0 };
  const { segments } = planTimeline(data, clipsById);
  for (const [i, seg] of segments.entries()) {
    onProgress((i / segments.length) * 0.3);
    try {
      const samples = await trackClip(seg.clip, seg.start, seg.end);
      cameras.set(seg.id, planCamera(samples, {
        start: seg.start, end: seg.end, srcW: seg.clip.width, srcH: seg.clip.height,
      }));
    } catch (err) {
      console.warn(`[camera] suivi impossible, cadrage centré : ${err.message}`);
    }
  }
  return { cameras, weight: 0.3 };
}

function renderMontage(data, clipsById) {
  return async (output, onProgress, jobId) => {
    const textDir = path.join(DATA_DIR, 'tmp', String(jobId));
    fs.mkdirSync(textDir, { recursive: true });
    let passes;
    let textFiles;
    let tempFiles = [];
    try {
      const musicPath = data.music ? path.join(MUSIC_DIR, path.basename(data.music.file)) : null;
      if (musicPath && !fs.existsSync(musicPath)) throw new Error(`Musique introuvable : ${data.music.file}`);
      const musicDuration = musicPath ? await probeDuration(musicPath) : null;
      const { cameras, weight } = await cameraPlans(data, clipsById, onProgress);
      ({ passes, textFiles, tempFiles } = buildMontageArgs(
        data, clipsById, { output, musicPath, musicDuration, textDir, cameras }));
      for (const [file, text] of Object.entries(textFiles)) fs.writeFileSync(file, text);
      let done = weight;
      for (const pass of passes) {
        await runFfmpeg(pass.args, pass.duration, (p) => onProgress(done + p * pass.weight * (1 - weight)));
        done += pass.weight * (1 - weight);
      }
    } finally {
      fs.rmSync(textDir, { recursive: true, force: true });
      for (const f of tempFiles) fs.rmSync(f, { force: true });
    }
  };
}

async function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift();
  const output = path.join(EXPORTS_DIR, `${job.id}_${safeName(job.label)}.mp4`);
  setStatus.run('running', null, job.id);

  let lastWrite = 0;
  try {
    await job.render(output, (p) => {
      if (Date.now() - lastWrite > 400) {
        lastWrite = Date.now();
        setProgress.run(p, job.id);
      }
    }, job.id);
    setDone.run(output, fs.statSync(output).size, job.id);
  } catch (err) {
    fs.rmSync(output, { force: true });
    setStatus.run('failed', err.message, job.id);
  } finally {
    busy = false;
    pump();
  }
}
