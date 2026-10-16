import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { getConfig, MUSIC_DIR, ROOT, updateConfig } from './config.js';
import { db } from './db.js';
import { enqueueExport, enqueueMontage } from './exports.js';
import { FORMATS, probeDuration } from './media.js';
import {
  applyTemplate, BUILTIN_TEMPLATES, planTimeline, sanitizeProjectData, templateFromProject,
} from './montage.js';
import { analyzeClip } from './highlights.js';
import { getJob, startJob } from './jobs.js';
import { applyListeners, guard, isLocal, remoteStatus, setRemote } from './remote.js';
import { groupCaptions, LANGUAGES, MODELS, transcribe } from './transcribe.js';
import { scan, state, thumbPath, VIDEO_EXTS, watchClipsDir } from './library.js';
import * as youtube from './youtube.js';

const PORT = Number(process.env.PORT || 4317);
const app = express();
app.use(guard);
app.use(express.json());

/** For settings that only make sense (or are only safe) from the PC itself. */
const localOnly = (req, res, next) => (isLocal(req) ? next()
  : res.status(403).json({ error: 'À faire depuis le PC' }));
app.use(express.static(path.join(ROOT, 'public')));

const getClip = db.prepare('SELECT * FROM clips WHERE id = ?');
const getExport = db.prepare('SELECT * FROM exports WHERE id = ?');

function notFound(res, what = 'Introuvable') {
  res.status(404).json({ error: what });
}

// ---- Library -------------------------------------------------------------

app.get('/api/status', (req, res) => {
  const exportsVersion = db.prepare(`
    SELECT (SELECT COUNT(*) FROM exports) + (SELECT COUNT(*) FROM publications) AS n,
           (SELECT COALESCE(SUM(progress), 0) FROM exports) +
           (SELECT COALESCE(SUM(progress), 0) FROM publications) +
           (SELECT COUNT(*) FROM publications WHERE status IN ('done', 'failed')) AS p`).get();
  res.json({
    ...state,
    clipsDir: getConfig().clipsDir,
    exportsKey: `${exportsVersion.n}:${exportsVersion.p}`,
  });
});

app.get('/api/clips', (req, res) => {
  const where = ['missing = 0'];
  const params = [];
  if (req.query.game) {
    where.push('game = ?');
    params.push(req.query.game);
  }
  if (req.query.favorite === '1') where.push('favorite = 1');
  if (req.query.q) {
    where.push(`(game LIKE ? OR filename LIKE ? OR COALESCE(title, '') LIKE ? OR tags LIKE ?)`);
    const like = `%${req.query.q}%`;
    params.push(like, like, like, like);
  }
  const order = {
    oldest: 'recorded_at ASC',
    longest: 'duration DESC',
    shortest: 'duration ASC',
  }[req.query.sort] || 'recorded_at DESC';
  res.json(db.prepare(`SELECT * FROM clips WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...params));
});

app.get('/api/games', (req, res) => {
  res.json(db.prepare(`
    SELECT game, COUNT(*) AS count, MAX(recorded_at) AS last
    FROM clips WHERE missing = 0 GROUP BY game ORDER BY last DESC`).all());
});

app.patch('/api/clips/:id', (req, res) => {
  const clip = getClip.get(req.params.id);
  if (!clip) return notFound(res);
  const { title, favorite, tags, game } = req.body;
  db.prepare(`UPDATE clips SET title = ?, favorite = ?, tags = ?, game = ? WHERE id = ?`).run(
    title !== undefined ? (title?.trim() || null) : clip.title,
    favorite !== undefined ? (favorite ? 1 : 0) : clip.favorite,
    tags !== undefined ? String(tags) : clip.tags,
    game?.trim() || clip.game,
    clip.id,
  );
  state.version++;
  res.json(getClip.get(clip.id));
});

app.get('/media/clips/:id', (req, res) => {
  const clip = getClip.get(req.params.id);
  if (!clip || !fs.existsSync(clip.path)) return notFound(res);
  res.sendFile(clip.path);
});

app.get('/media/thumbs/:id', (req, res) => {
  const file = thumbPath(Number(req.params.id));
  if (!fs.existsSync(file)) return notFound(res);
  res.sendFile(file, { maxAge: '1h' });
});

app.post('/api/scan', (req, res) => {
  scan();
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => res.json({ clipsDir: getConfig().clipsDir }));

app.put('/api/settings', localOnly, (req, res) => {
  const clipsDir = String(req.body.clipsDir || '').trim();
  if (!path.isAbsolute(clipsDir)) return res.status(400).json({ error: 'Chemin absolu requis' });
  try {
    updateConfig({ clipsDir });
    watchClipsDir();
    scan();
    res.json({ clipsDir });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Drag & drop import: raw body, copied into <clipsDir>/Imports
app.post('/api/upload', async (req, res) => {
  const original = path.basename(decodeURIComponent(String(req.get('x-filename') || '')));
  const ext = path.extname(original).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return res.status(400).json({ error: `Format non supporté: ${ext || '?'}` });

  const dir = path.join(getConfig().clipsDir, 'Imports');
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(original, path.extname(original));
  let target = path.join(dir, original);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem} (${i})${ext}`);

  try {
    await pipeline(req, fs.createWriteStream(target));
    scan();
    res.json({ ok: true });
  } catch (err) {
    fs.rmSync(target, { force: true });
    res.status(500).json({ error: err.message });
  }
});

// ---- Exports -------------------------------------------------------------

app.post('/api/clips/:id/export', (req, res) => {
  const clip = getClip.get(req.params.id);
  if (!clip) return notFound(res);
  const start = Math.max(0, Number(req.body.start) || 0);
  const end = Math.min(clip.duration, Number(req.body.end) || clip.duration);
  const format = [...FORMATS, 'vertical-fight'].includes(req.body.format) ? req.body.format : 'original';
  if (end - start < 0.3) return res.status(400).json({ error: 'Sélection trop courte' });
  const id = enqueueExport(clip, {
    start, end, format, mute: !!req.body.mute, title: req.body.title || null,
  });
  res.json(getExport.get(id));
});

app.get('/api/exports', (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, c.game, p.name AS project_name FROM exports e
    LEFT JOIN clips c ON c.id = e.clip_id LEFT JOIN projects p ON p.id = e.project_id
    ORDER BY e.id DESC`).all());
});

app.get('/media/exports/:id', (req, res) => {
  const exp = getExport.get(req.params.id);
  if (!exp?.out_path || !fs.existsSync(exp.out_path)) return notFound(res);
  if (req.query.download) res.download(exp.out_path, path.basename(exp.out_path).replace(/^\d+_/, ''));
  else res.sendFile(exp.out_path);
});

app.delete('/api/exports/:id', (req, res) => {
  const exp = getExport.get(req.params.id);
  if (!exp) return notFound(res);
  if (exp.status === 'running' || exp.status === 'queued') {
    return res.status(409).json({ error: 'Export en cours' });
  }
  if (exp.out_path) fs.rmSync(exp.out_path, { force: true });
  db.prepare('DELETE FROM exports WHERE id = ?').run(exp.id);
  res.json({ ok: true });
});


// ---- Montages --------------------------------------------------------------

const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');

function clipsFor(data) {
  const ids = [...new Set(data.segments.map((s) => s.clipId))];
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT * FROM clips WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((c) => [c.id, c]));
}

function projectSummary(row) {
  const data = sanitizeProjectData(JSON.parse(row.data));
  const { total, segments } = planTimeline(data, clipsFor(data));
  return {
    id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at,
    format: data.format, segments: segments.length, duration: total,
    coverClipId: data.segments[0]?.clipId ?? null,
  };
}

app.get('/api/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all().map(projectSummary));
});

app.post('/api/projects', (req, res) => {
  let data = sanitizeProjectData(req.body.data || {});
  const tpl = req.body.templateId && db.prepare('SELECT * FROM templates WHERE id = ?').get(req.body.templateId);
  if (tpl) data = applyTemplate(data, JSON.parse(tpl.data));
  for (const clipId of req.body.clipIds || []) {
    const clip = getClip.get(clipId);
    if (clip) data.segments.push(...sanitizeProjectData({ segments: [{ clipId, start: 0, end: clip.duration }] }).segments);
  }
  const name = String(req.body.name || '').trim() || `Montage du ${new Date().toLocaleDateString('fr-FR')}`;
  const id = Number(db.prepare('INSERT INTO projects (name, data) VALUES (?, ?)')
    .run(name.slice(0, 120), JSON.stringify(data)).lastInsertRowid);
  res.json(projectDetail(id));
});

function projectDetail(id) {
  const row = getProject.get(id);
  if (!row) return null;
  const data = sanitizeProjectData(JSON.parse(row.data));
  return { ...projectSummary(row), data, clips: Object.fromEntries(clipsFor(data)) };
}

app.get('/api/projects/:id', (req, res) => {
  const p = projectDetail(req.params.id);
  return p ? res.json(p) : notFound(res);
});

app.put('/api/projects/:id', (req, res) => {
  const row = getProject.get(req.params.id);
  if (!row) return notFound(res);
  const name = String(req.body.name ?? row.name).trim().slice(0, 120) || row.name;
  const data = req.body.data ? sanitizeProjectData(req.body.data) : JSON.parse(row.data);
  db.prepare(`UPDATE projects SET name = ?, data = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, JSON.stringify(data), row.id);
  res.json(projectDetail(row.id));
});

app.post('/api/projects/:id/segments', (req, res) => {
  const row = getProject.get(req.params.id);
  const clip = getClip.get(req.body.clipId);
  if (!row || !clip) return notFound(res);
  const data = sanitizeProjectData(JSON.parse(row.data));
  const start = Math.max(0, Number(req.body.start) || 0);
  const end = Math.min(clip.duration, Number(req.body.end) || clip.duration);
  data.segments.push(...sanitizeProjectData({ segments: [{ clipId: clip.id, start, end }] }).segments);
  db.prepare(`UPDATE projects SET data = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(data), row.id);
  res.json(projectDetail(row.id));
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/render', (req, res) => {
  const row = getProject.get(req.params.id);
  if (!row) return notFound(res);
  const data = sanitizeProjectData(JSON.parse(row.data));
  const clips = clipsFor(data);
  const missing = data.segments.filter((s) => !clips.get(s.clipId) || !fs.existsSync(clips.get(s.clipId).path));
  if (missing.length) return res.status(400).json({ error: `${missing.length} clip(s) introuvable(s) sur le disque` });
  if (!planTimeline(data, clips).segments.length) return res.status(400).json({ error: 'Ajoute au moins un clip' });
  const id = enqueueMontage(row, data, clips);
  res.json(getExport.get(id));
});

// ---- Music library -----------------------------------------------------------

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.opus']);

app.get('/api/music', async (req, res) => {
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  const list = await Promise.all(files.map(async (file) => {
    const duration = await probeDuration(path.join(MUSIC_DIR, file)).catch(() => null);
    return { file, duration, size: fs.statSync(path.join(MUSIC_DIR, file)).size };
  }));
  res.json(list.sort((a, b) => a.file.localeCompare(b.file)));
});

app.post('/api/music', async (req, res) => {
  const original = path.basename(decodeURIComponent(String(req.get('x-filename') || '')));
  const ext = path.extname(original).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return res.status(400).json({ error: `Format audio non supporté: ${ext || '?'}` });
  const stem = path.basename(original, ext);
  let target = path.join(MUSIC_DIR, original);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(MUSIC_DIR, `${stem} (${i})${ext}`);
  try {
    await pipeline(req, fs.createWriteStream(target));
    await probeDuration(target);
    res.json({ file: path.basename(target) });
  } catch (err) {
    fs.rmSync(target, { force: true });
    res.status(400).json({ error: `Fichier audio illisible: ${err.message}` });
  }
});

app.get('/media/music/:file', (req, res) => {
  const file = path.join(MUSIC_DIR, path.basename(req.params.file));
  if (!fs.existsSync(file)) return notFound(res);
  res.sendFile(file);
});

app.delete('/api/music/:file', (req, res) => {
  fs.rmSync(path.join(MUSIC_DIR, path.basename(req.params.file)), { force: true });
  res.json({ ok: true });
});


// ---- Publishing ----------------------------------------------------------------

const redirectUri = (req) => `http://localhost:${PORT}/api/youtube/callback`;

app.get('/api/youtube', (req, res) => res.json(youtube.status(redirectUri(req))));

app.put('/api/youtube/credentials', localOnly, (req, res) => {
  try {
    youtube.setCredentials(req.body);
    res.json(youtube.status(redirectUri(req)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/youtube/connect', localOnly, (req, res) => {
  try {
    res.redirect(youtube.authUrl(redirectUri(req)));
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/api/youtube/callback', async (req, res) => {
  try {
    await youtube.handleCallback(req.query, redirectUri(req));
    res.redirect('/#youtube=connected');
  } catch (err) {
    res.redirect(`/#youtube=error&message=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/youtube/disconnect', (req, res) => {
  youtube.disconnect();
  res.json(youtube.status(redirectUri(req)));
});

const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x'];

app.post('/api/exports/:id/publish', (req, res) => {
  const exp = getExport.get(req.params.id);
  if (!exp || exp.status !== 'done' || !fs.existsSync(exp.out_path || '')) return notFound(res, 'Export introuvable');
  const platform = req.body.platform;
  if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Plateforme inconnue' });

  const title = String(req.body.title || '').trim();
  const meta = {
    title,
    description: String(req.body.description || ''),
    tags: (Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(','))
      .map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean).slice(0, 30),
    privacy: ['public', 'unlisted', 'private'].includes(req.body.privacy) ? req.body.privacy : 'private',
    publishAt: req.body.publishAt || null,
    short: !!req.body.short,
  };

  if (platform === 'youtube') {
    if (!title) return res.status(400).json({ error: 'Titre requis' });
    if (!youtube.status().connected) return res.status(400).json({ error: 'Connecte d’abord ton compte YouTube' });
    if (meta.publishAt && !(new Date(meta.publishAt) > new Date())) {
      return res.status(400).json({ error: 'La date de programmation doit être dans le futur' });
    }
  }

  // Other platforms have no usable local API (app audit / public HTTPS needed), so they're
  // logged as "manual": the UI hands over the file and caption and opens the upload page.
  const status = platform === 'youtube' ? 'queued' : 'done';
  const id = Number(db.prepare('INSERT INTO publications (export_id, platform, status, progress, meta) VALUES (?, ?, ?, ?, ?)')
    .run(exp.id, platform, status, status === 'done' ? 1 : 0, JSON.stringify(meta)).lastInsertRowid);
  if (platform === 'youtube') youtube.enqueueYoutube(id, exp.out_path, meta);
  res.json(db.prepare('SELECT * FROM publications WHERE id = ?').get(id));
});

app.get('/api/publications', (req, res) => {
  res.json(db.prepare('SELECT * FROM publications ORDER BY id DESC').all());
});


// ---- Highlights ----------------------------------------------------------------

/** Cached per file size, so a re-recorded/replaced file is analysed again. */
async function clipAnalysis(clip) {
  const cached = clip.analysis && JSON.parse(clip.analysis);
  if (cached?.size === clip.size) return cached;
  const result = { ...(await analyzeClip(clip)), size: clip.size };
  db.prepare('UPDATE clips SET analysis = ? WHERE id = ?').run(JSON.stringify(result), clip.id);
  return result;
}

app.get('/api/clips/:id/highlights', async (req, res) => {
  const clip = getClip.get(req.params.id);
  if (!clip) return notFound(res);
  try {
    res.json(await clipAnalysis(clip));
  } catch (err) {
    res.status(500).json({ error: `Analyse impossible : ${err.message}` });
  }
});

// Best-of: the strongest moment of each clip, in recording order, capped at maxDuration.
app.post('/api/projects/auto', (req, res) => {
  const ids = (req.body.clipIds || []).map(Number);
  const clips = ids.map((id) => getClip.get(id)).filter((c) => c && !c.missing)
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  if (!clips.length) return res.status(400).json({ error: 'Sélectionne au moins un clip' });
  const perClip = Math.max(1, Math.min(5, Number(req.body.perClip) || 1));
  const maxDuration = Math.max(5, Number(req.body.maxDuration) || 60);

  const job = startJob('auto-montage', async (update) => {
    const picks = [];
    for (const [i, clip] of clips.entries()) {
      update({ progress: i / clips.length, message: `Analyse de ${clip.title || clip.game} (${i + 1}/${clips.length})…` });
      const { highlights } = await clipAnalysis(clip);
      const best = highlights.slice(0, perClip);
      // nothing stood out: keep the middle of the clip
      if (!best.length) best.push({ start: Math.max(0, clip.duration / 2 - 3), end: Math.min(clip.duration, clip.duration / 2 + 3), score: 0 });
      for (const h of best.sort((a, b) => a.start - b.start)) picks.push({ clipId: clip.id, start: h.start, end: h.end, score: h.score });
    }
    // over budget: drop the weakest moments, keep the order
    let total = picks.reduce((t, p) => t + p.end - p.start, 0);
    while (total > maxDuration && picks.length > 1) {
      const weakest = picks.reduce((w, p) => (p.score < w.score ? p : w));
      picks.splice(picks.indexOf(weakest), 1);
      total -= weakest.end - weakest.start;
    }
    let data = sanitizeProjectData({ segments: picks });
    const tpl = req.body.templateId && db.prepare('SELECT * FROM templates WHERE id = ?').get(req.body.templateId);
    if (tpl) data = applyTemplate(data, JSON.parse(tpl.data));
    const name = `Best-of auto du ${new Date().toLocaleDateString('fr-FR')}`;
    const id = Number(db.prepare('INSERT INTO projects (name, data) VALUES (?, ?)').run(name, JSON.stringify(data)).lastInsertRowid);
    return { projectId: id };
  });
  res.json(job);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  return job ? res.json(job) : notFound(res);
});

// ---- Subtitles -----------------------------------------------------------------

app.post('/api/projects/:id/subtitles', (req, res) => {
  const row = getProject.get(req.params.id);
  if (!row) return notFound(res);
  const language = LANGUAGES.includes(req.body.language) ? req.body.language : 'french';
  const quality = MODELS[req.body.quality] ? req.body.quality : 'fast';
  const maxWords = Math.max(1, Math.min(10, Number(req.body.maxWords) || 4));
  const style = sanitizeProjectData({ texts: [{ text: 'x', ...req.body.style }] }).texts[0];
  const upper = !!req.body.upper;

  const job = startJob('subtitles', async (update) => {
    const data = sanitizeProjectData(JSON.parse(row.data));
    const { segments, td } = planTimeline(data, clipsFor(data));
    const texts = [];
    let offset = 0;
    for (const [i, seg] of segments.entries()) {
      update({ progress: i / segments.length, message: `Écoute du clip ${i + 1}/${segments.length}…` });
      if (seg.clip.has_audio) {
        const words = await transcribe(seg.clip.path, {
          start: seg.start, duration: seg.dur, language, quality,
          onStatus: (message) => update({ message }),
        });
        for (const c of groupCaptions(words, { maxWords })) {
          if (c.start >= seg.dur) continue;
          texts.push({
            ...style, id: undefined, auto: true,
            text: upper ? c.text.toLocaleUpperCase('fr-FR') : c.text,
            start: offset + c.start,
            end: offset + Math.min(c.end, seg.dur),
          });
        }
      }
      offset += seg.dur - td;
    }
    // re-read: the user may have edited the project while we were listening
    const latest = sanitizeProjectData(JSON.parse(getProject.get(row.id).data));
    latest.texts = [...latest.texts.filter((t) => !t.auto), ...sanitizeProjectData({ texts }).texts];
    db.prepare(`UPDATE projects SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(latest), row.id);
    return { count: texts.length };
  });
  res.json(job);
});

// ---- Templates -----------------------------------------------------------------

{
  // add built-ins that don't exist yet (new versions bring new ones)
  const have = new Set(db.prepare('SELECT name FROM templates WHERE builtin = 1').all().map((t) => t.name));
  const insert = db.prepare('INSERT INTO templates (name, data, builtin) VALUES (?, ?, 1)');
  for (const t of BUILTIN_TEMPLATES) if (!have.has(t.name)) insert.run(t.name, JSON.stringify(t.data));
}

const templateRow = (t) => ({ id: t.id, name: t.name, builtin: !!t.builtin, data: JSON.parse(t.data) });

app.get('/api/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM templates ORDER BY builtin DESC, name').all().map(templateRow));
});

app.post('/api/templates', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  let data;
  if (req.body.projectId) {
    const row = getProject.get(req.body.projectId);
    if (!row) return notFound(res);
    data = templateFromProject(JSON.parse(row.data));
  } else {
    data = templateFromProject(req.body.data || {});
  }
  const id = Number(db.prepare('INSERT INTO templates (name, data) VALUES (?, ?)').run(name, JSON.stringify(data)).lastInsertRowid);
  res.json(templateRow(db.prepare('SELECT * FROM templates WHERE id = ?').get(id)));
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/apply-template', (req, res) => {
  const row = getProject.get(req.params.id);
  const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.body.templateId);
  if (!row || !tpl) return notFound(res);
  const data = applyTemplate(JSON.parse(row.data), JSON.parse(tpl.data));
  db.prepare(`UPDATE projects SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(data), row.id);
  res.json(projectDetail(row.id));
});

// ---- Phone access ----------------------------------------------------------------

app.get('/api/remote', localOnly, async (req, res) => res.json(await remoteStatus(PORT)));

app.put('/api/remote', localOnly, async (req, res) => {
  await setRemote(!!req.body.enabled, app, PORT, { rotate: !!req.body.rotate });
  res.json(await remoteStatus(PORT));
});

app.listen(PORT, '127.0.0.1', (err) => {
  // Express 5 reports listen errors here instead of throwing
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `Le port ${PORT} est déjà utilisé : ClipForge tourne sûrement déjà (http://localhost:${PORT}).`
      : `Démarrage impossible : ${err.message}`);
    process.exit(1);
  }
  console.log(`ClipForge → http://localhost:${PORT}`);
  console.log(`Dossier des clips : ${getConfig().clipsDir}`);
  watchClipsDir();
  scan();
  setInterval(scan, 60_000);
  applyListeners(app, PORT).then(() => {
    if (getConfig().remote?.enabled) console.log('Accès téléphone activé (voir Réglages)');
  });
});
