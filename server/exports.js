import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, EXPORTS_DIR, MUSIC_DIR } from './config.js';
import { db } from './db.js';
import { exportVideo, probeDuration, runFfmpeg } from './media.js';
import { buildMontageArgs } from './montage.js';

const setStatus = db.prepare('UPDATE exports SET status = ?, error = ? WHERE id = ?');
const setProgress = db.prepare('UPDATE exports SET progress = ? WHERE id = ?');
const setDone = db.prepare(`UPDATE exports SET status = 'done', progress = 1, out_path = ?, size = ? WHERE id = ?`);
const insertExport = db.prepare('INSERT INTO exports (clip_id, project_id, name, options) VALUES (?, ?, ?, ?)');

const FORMAT_LABEL = { original: 'original', 'vertical-blur': '9:16 flou', 'vertical-crop': '9:16 recadré' };

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
    render: async (output, onProgress, jobId) => {
      const textDir = path.join(DATA_DIR, 'tmp', String(jobId));
      fs.mkdirSync(textDir, { recursive: true });
      let passes;
      let textFiles;
      let tempFiles = [];
      try {
        const musicPath = data.music ? path.join(MUSIC_DIR, path.basename(data.music.file)) : null;
        if (musicPath && !fs.existsSync(musicPath)) throw new Error(`Musique introuvable : ${data.music.file}`);
        const musicDuration = musicPath ? await probeDuration(musicPath) : null;
        ({ passes, textFiles, tempFiles } = buildMontageArgs(
          data, clipsById, { output, musicPath, musicDuration, textDir }));
        for (const [file, text] of Object.entries(textFiles)) fs.writeFileSync(file, text);
        let done = 0;
        for (const pass of passes) {
          await runFfmpeg(pass.args, pass.duration, (p) => onProgress(done + p * pass.weight));
          done += pass.weight;
        }
      } finally {
        fs.rmSync(textDir, { recursive: true, force: true });
        for (const f of tempFiles) fs.rmSync(f, { force: true });
      }
    },
  });
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
