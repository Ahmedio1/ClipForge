// ClipForge as an MCP server: lets the user's own AI app (Claude Code, Gemini CLI, Claude
// Desktop… on their subscription) drive the editor. Tools are thin wrappers over the HTTP API,
// so the same code serves the in-app /mcp endpoint and the stdio bridge (bin/clipforge-mcp.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const FORMATS = ['original', 'vertical-blur', 'vertical-crop', 'vertical-fight'];
const FITS = ['blur', 'crop', 'bars', 'fight'];
const TRANSITIONS = ['none', 'fade', 'fadeblack', 'dissolve', 'wipeleft', 'slideleft', 'circleopen', 'zoomin'];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMcpServer(baseUrl) {
  async function call(pathname, opts = {}) {
    let res;
    try {
      res = await fetch(baseUrl + pathname, {
        ...opts,
        headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      });
    } catch {
      throw new Error(`ClipForge ne répond pas sur ${baseUrl} : lance-le avec « npm start ».`);
    }
    if (res.headers.get('content-type')?.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
    return body;
  }
  const post = (p, data) => call(p, { method: 'POST', body: JSON.stringify(data ?? {}) });
  const put = (p, data) => call(p, { method: 'PUT', body: JSON.stringify(data) });

  async function waitJob(job, timeoutMs = 600_000) {
    const t0 = Date.now();
    for (;;) {
      const j = await call(`/api/jobs/${job.id}`);
      if (j.status === 'done') return j.result;
      if (j.status === 'failed') throw new Error(j.error);
      if (Date.now() - t0 > timeoutMs) throw new Error('Trop long, réessaie plus tard');
      await sleep(500);
    }
  }

  async function waitExport(id, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const e = (await call('/api/exports')).find((x) => x.id === id);
      if (!e || e.status === 'done' || e.status === 'failed' || Date.now() - t0 > timeoutMs) return e;
      await sleep(1000);
    }
  }

  const exportSummary = (e) => e && ({
    exportId: e.id, name: e.name, status: e.status, progress: Math.round(e.progress * 100),
    file: e.out_path, error: e.error || undefined,
  });

  const server = new McpServer({ name: 'clipforge', version: '1.0.0' }, {
    instructions: `ClipForge is the user's local library of game clips (mostly fighting games such as TEKKEN 8, recorded with Xbox Game Bar) and their video editor for TikTok / YouTube Shorts.
Typical flow: list_clips → get_clip_highlights / view_clip to see the action → create_montage with the chosen clips → edit_montage (cuts, order, texts, style) → render_montage → view_export to check the result → publish_youtube if the user asks.
For vertical shorts of fighting games, prefer format "vertical" with fit "fight" (HUD band + camera that follows the fighters). Times are in seconds. Answer the user in their language (usually French).`,
  });

  // Errors from the HTTP API become readable tool errors instead of protocol failures.
  const register = (name, config, fn) => server.registerTool(name, config, async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err.message);
    }
  });

  register('list_clips', {
    title: 'Lister les clips',
    description: 'Lists the clips in the library (newest first): id, game, title, date, duration, tags.',
    inputSchema: {
      query: z.string().optional().describe('Text to search in game, title, tags'),
      game: z.string().optional().describe('Exact game name'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async ({ query, game, limit = 50 }) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (game) params.set('game', game);
    const clips = await call(`/api/clips?${params}`);
    return text(clips.slice(0, limit).map((c) => ({
      id: c.id, game: c.game, title: c.title, recorded_at: c.recorded_at, duration: Number(c.duration.toFixed(1)),
      resolution: `${c.width}x${c.height}`, has_audio: !!c.has_audio, favorite: !!c.favorite, tags: c.tags || undefined,
    })));
  });

  register('get_clip_highlights', {
    title: 'Moments forts d’un clip',
    description: 'Detected high-intensity moments of a clip (sound peaks: hits, KOs, shouts), strongest first, with a suggested cut [start, end].',
    inputSchema: { clipId: z.number().int() },
  }, async ({ clipId }) => text(await call(`/api/clips/${clipId}/highlights`).then((h) => ({ source: h.source, highlights: h.highlights }))));

  async function frames(kind, id, times) {
    const content = [];
    for (const t of times) {
      const img = await call(`/api/${kind}/${id}/frame?t=${t}`);
      content.push({ type: 'text', text: `t = ${t.toFixed(1)} s` });
      content.push({ type: 'image', data: img.toString('base64'), mimeType: 'image/jpeg' });
    }
    return { content };
  }

  register('view_clip', {
    title: 'Regarder un clip',
    description: 'Returns still images of a clip at the given times (or spread over the clip / at its highlights) so you can see what happens.',
    inputSchema: {
      clipId: z.number().int(),
      times: z.array(z.number().min(0)).max(8).optional().describe('Seconds; default: highlights or 4 evenly spaced frames'),
    },
  }, async ({ clipId, times }) => {
    const clip = (await call('/api/clips')).find((c) => c.id === clipId);
    if (!clip) return fail(`Clip ${clipId} introuvable`);
    let ts = times;
    if (!ts?.length) {
      const h = await call(`/api/clips/${clipId}/highlights`).catch(() => ({ highlights: [] }));
      ts = h.highlights.length ? h.highlights.slice(0, 4).map((x) => x.time) : [0.15, 0.4, 0.65, 0.9].map((f) => f * clip.duration);
    }
    return frames('clips', clipId, ts.map((t) => Math.min(t, clip.duration - 0.1)));
  });

  register('list_templates', {
    title: 'Modèles de montage',
    description: 'Montage style templates (e.g. "Combat (Tekken, Street Fighter…)", "TikTok dynamique").',
    inputSchema: {},
  }, async () => text((await call('/api/templates')).map((t) => ({ id: t.id, name: t.name, ...t.data }))));

  register('list_montages', {
    title: 'Lister les montages',
    description: 'Existing montages (projects) with their duration and number of clips.',
    inputSchema: {},
  }, async () => text(await call('/api/projects')));

  register('get_montage', {
    title: 'Voir un montage',
    description: 'Full description of a montage: segments (clip extracts in order), texts, style.',
    inputSchema: { projectId: z.number().int() },
  }, async ({ projectId }) => {
    const p = await call(`/api/projects/${projectId}`);
    return text({ id: p.id, name: p.name, duration: p.duration, data: p.data });
  });

  register('create_montage', {
    title: 'Créer un montage',
    description: 'Creates a montage from clips (each clip added in full, in the given order). Then use edit_montage to cut and style it.',
    inputSchema: {
      clipIds: z.array(z.number().int()).min(1),
      name: z.string().optional(),
      template: z.string().optional().describe('Template name from list_templates, e.g. "Combat (Tekken, Street Fighter…)"'),
    },
  }, async ({ clipIds, name, template }) => {
    let templateId = null;
    if (template) {
      const t = (await call('/api/templates')).find((x) => x.name.toLowerCase().includes(template.toLowerCase()));
      if (!t) return fail(`Modèle « ${template} » introuvable`);
      templateId = t.id;
    }
    const p = await post('/api/projects', { clipIds, name, templateId });
    return text({ projectId: p.id, name: p.name, duration: p.duration, data: p.data });
  });

  register('edit_montage', {
    title: 'Modifier un montage',
    description: 'Changes a montage. Only the fields you pass change. "segments" replaces the whole sequence; "texts" replaces the manual texts (automatic subtitles are kept).',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().optional(),
      format: z.enum(['vertical', 'landscape']).optional(),
      fit: z.enum(FITS).optional().describe('fight = fighting games: HUD band + camera following the characters'),
      fps: z.union([z.literal(30), z.literal(60)]).optional(),
      transition: z.enum(TRANSITIONS).optional(),
      transitionDuration: z.number().min(0.1).max(2).optional(),
      fadeInOut: z.boolean().optional(),
      segments: z.array(z.object({ clipId: z.number().int(), start: z.number().min(0), end: z.number().min(0) })).optional(),
      texts: z.array(z.object({
        text: z.string(), start: z.number().min(0), end: z.number().min(0).describe('≥ 9999 = until the end'),
        position: z.enum(['top', 'center', 'bottom']).optional(), size: z.enum(['S', 'M', 'L']).optional(),
        color: z.string().optional().describe('#rrggbb'), box: z.boolean().optional(),
      })).optional(),
    },
  }, async ({ projectId, name, segments, texts, ...style }) => {
    const p = await call(`/api/projects/${projectId}`);
    const data = { ...p.data, ...Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)) };
    if (segments) {
      const known = new Set((await call('/api/clips')).map((c) => c.id));
      const unknown = segments.filter((s) => !known.has(s.clipId)).map((s) => s.clipId);
      if (unknown.length) return fail(`Clips inconnus : ${unknown.join(', ')}`);
      data.segments = segments;
      data.pool = [...new Set([...(data.pool || []), ...segments.map((s) => s.clipId)])];
    }
    if (texts) data.texts = [...data.texts.filter((t) => t.auto), ...texts];
    const saved = await put(`/api/projects/${projectId}`, { name, data });
    return text({ projectId: saved.id, name: saved.name, duration: saved.duration, data: saved.data });
  });

  register('generate_subtitles', {
    title: 'Sous-titres automatiques',
    description: 'Transcribes the voices in the montage (local Whisper) and adds them as captions. Can take a minute.',
    inputSchema: {
      projectId: z.number().int(),
      language: z.enum(['french', 'english', 'spanish', 'german', 'italian', 'portuguese', 'arabic']).optional(),
      style: z.enum(['tiktok', 'classic']).optional(),
    },
  }, async ({ projectId, language = 'french', style = 'tiktok' }) => {
    const preset = style === 'tiktok'
      ? { style: { position: 'center', size: 'L', box: false }, upper: true }
      : { style: { position: 'bottom', size: 'M', box: true }, upper: false };
    const r = await waitJob(await post(`/api/projects/${projectId}/subtitles`, { language, maxWords: 4, ...preset }));
    return text(`${r.count} sous-titres ajoutés.`);
  });

  register('render_montage', {
    title: 'Rendre la vidéo',
    description: 'Renders the montage to an MP4. Waits up to waitSeconds (default 240) and returns the export status; use get_export later if still running.',
    inputSchema: { projectId: z.number().int(), waitSeconds: z.number().int().min(0).max(900).optional() },
  }, async ({ projectId, waitSeconds = 240 }) => {
    const job = await post(`/api/projects/${projectId}/render`);
    return text(exportSummary(await waitExport(job.id, waitSeconds * 1000)));
  });

  register('export_clip', {
    title: 'Exporter un extrait',
    description: 'Exports one clip extract alone. Formats: original, vertical-blur, vertical-crop, vertical-fight (fighting games).',
    inputSchema: {
      clipId: z.number().int(), start: z.number().min(0), end: z.number().min(0), format: z.enum(FORMATS),
      title: z.string().optional(), waitSeconds: z.number().int().min(0).max(900).optional(),
    },
  }, async ({ clipId, start, end, format, title, waitSeconds = 180 }) => {
    const job = await post(`/api/clips/${clipId}/export`, { start, end, format, title });
    return text(exportSummary(await waitExport(job.id, waitSeconds * 1000)));
  });

  register('get_export', {
    title: 'État d’un export',
    description: 'Status of a rendered video (or all of them if exportId is omitted).',
    inputSchema: { exportId: z.number().int().optional() },
  }, async ({ exportId }) => {
    const list = await call('/api/exports');
    return text(exportId ? exportSummary(list.find((e) => e.id === exportId)) || 'Introuvable' : list.map(exportSummary));
  });

  register('view_export', {
    title: 'Regarder le rendu',
    description: 'Still images of a rendered video, to check framing, texts and quality before publishing.',
    inputSchema: { exportId: z.number().int(), count: z.number().int().min(1).max(8).optional() },
  }, async ({ exportId, count = 4 }) => {
    const e = (await call('/api/exports')).find((x) => x.id === exportId);
    if (!e || e.status !== 'done') return fail('Export introuvable ou pas terminé');
    const opts = JSON.parse(e.options);
    const duration = opts.montage ? null : opts.end - opts.start;
    const total = duration ?? (await call(`/api/projects/${e.project_id}`)).duration;
    return frames('exports', exportId, Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * total));
  });

  register('publish_youtube', {
    title: 'Publier sur YouTube',
    description: 'Uploads a finished export to the user’s connected YouTube channel. Only when the user asked to publish.',
    inputSchema: {
      exportId: z.number().int(), title: z.string().max(100), description: z.string().optional(),
      tags: z.array(z.string()).optional(), privacy: z.enum(['private', 'unlisted', 'public']).optional(),
      publishAt: z.string().optional().describe('ISO date to schedule'), short: z.boolean().optional(),
    },
  }, async (args) => {
    const pub = await post(`/api/exports/${args.exportId}/publish`, { platform: 'youtube', privacy: 'private', ...args });
    return text({ publicationId: pub.id, status: pub.status, note: 'Envoi lancé ; le lien apparaîtra dans « Exports & publication ».' });
  });

  return server;
}
