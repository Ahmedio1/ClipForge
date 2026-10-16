// What the AI does in ClipForge. Every feature builds a context, asks for JSON, validates it.
import { askJson } from './ai.js';
import { runBuffer } from './highlights.js';
import { sanitizeProjectData, CANVAS, FITS, GRADES, SPEEDS, TRANSITIONS } from './montage.js';

const SYSTEM = `Tu es le monteur vidéo d'un joueur qui publie des clips de jeux vidéo sur TikTok, YouTube Shorts et Instagram.
Tu connais les codes de ces plateformes : accroche dans les 2 premières secondes, textes courts et percutants, hashtags pertinents.
Tu écris en français familier mais propre, sans inventer de faits que tu ne vois pas dans les images ou les informations fournies (noms de personnages, scores…).`;

/** One JPEG (base64) of a video at `time` seconds, 512 px wide: enough for the AI to see the action. */
export async function frameAt(file, time) {
  const buf = await runBuffer(['-v', 'error', '-ss', String(Math.max(0, time)), '-i', file, '-frames:v', '1',
    '-vf', 'scale=512:-2', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
  return buf.toString('base64');
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---- 1. Publication texts ---------------------------------------------------------------

const PLATFORM_RULES = {
  youtube: 'YouTube (Shorts si vertical) : titre ≤ 100 caractères, description de 2-4 lignes, hashtags à la fin (3 à 5, dont #Shorts si vertical).',
  tiktok: 'TikTok : pas de titre séparé (mets la légende dans "description"), légende courte et punchy, 4 à 6 hashtags.',
  instagram: 'Instagram Reels : légende engageante de 1-3 lignes avec une question pour les commentaires, 5 à 8 hashtags.',
  x: 'X (Twitter) : un seul message de moins de 250 caractères hashtags compris, 1 à 2 hashtags.',
};

export async function publishTexts({ exp, game, transcript, platform, file, duration }) {
  const times = [0.2, 0.5, 0.8].map((f) => f * duration);
  const images = await Promise.all(times.map((t) => frameAt(file, t)));
  const prompt = [
    `Vidéo à publier : « ${exp.name} »${game ? `, jeu : ${game}` : ''}, durée ${fmt(duration)}, format ${/9:16/.test(exp.name) ? 'vertical' : 'horizontal'}.`,
    transcript ? `Paroles entendues dans la vidéo : « ${transcript.slice(0, 1500)} »` : '',
    `Les ${images.length} images jointes sont extraites du début, du milieu et de la fin.`,
    `Rédige les textes de publication pour ${PLATFORM_RULES[platform] || PLATFORM_RULES.tiktok}`,
    'Hashtags sans le symbole #, sans espaces.',
  ].filter(Boolean).join('\n');
  const out = await askJson({
    system: SYSTEM,
    prompt,
    images,
    effort: 'low',
    schema: {
      type: 'object', additionalProperties: false, required: ['title', 'description', 'hashtags'],
      properties: { title: { type: 'string' }, description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } },
    },
  });
  return {
    title: String(out.title || '').slice(0, 100),
    description: String(out.description || ''),
    hashtags: (Array.isArray(out.hashtags) ? out.hashtags : []).map((h) => String(h).replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean).slice(0, 10),
  };
}

// ---- 2. Hook titles ----------------------------------------------------------------------

export async function hookIdeas({ projectName, segments, transcript }) {
  const images = await Promise.all(segments.slice(0, 4).map((s) => frameAt(s.clip.path, s.start + s.dur / 2)));
  const games = [...new Set(segments.map((s) => s.clip.game))].join(', ');
  const out = await askJson({
    system: SYSTEM,
    prompt: [
      `Montage « ${projectName} » (${games}), ${segments.length} moment(s). Images jointes : un extrait de chaque moment.`,
      transcript ? `Paroles : « ${transcript.slice(0, 1000)} »` : '',
      'Propose 4 textes d’accroche à afficher en grand en haut de la vidéo pendant les 3 premières secondes.',
      'Chacun : 2 à 7 mots, qui donnent envie de regarder jusqu’au bout (défi, question, promesse, émotion). Emojis autorisés avec parcimonie.',
    ].filter(Boolean).join('\n'),
    images,
    effort: 'low',
    schema: {
      type: 'object', additionalProperties: false, required: ['hooks'],
      properties: { hooks: { type: 'array', items: { type: 'string' } } },
    },
  });
  return (out.hooks || []).map((h) => String(h).trim()).filter(Boolean).slice(0, 6);
}

// ---- 3. Picking the best moments by looking at them ------------------------------------------

/**
 * `candidates`: [{ clip, start, end, time, score }]. Shows one frame of each to the AI and
 * returns the candidates ordered best first (those it rejects are dropped).
 */
export async function rankMoments(candidates, onStatus) {
  onStatus?.('L’IA regarde les moments…');
  const images = await Promise.all(candidates.map((c) => frameAt(c.clip.path, c.time)));
  const list = candidates.map((c, i) =>
    `Image ${i + 1} : ${c.clip.game}${c.clip.title ? ` « ${c.clip.title} »` : ''}, à ${fmt(c.time)}, intensité sonore ${Math.round(c.score * 100)} %`).join('\n');
  const out = await askJson({
    system: SYSTEM,
    prompt: [
      'Pour un best-of, voici des moments candidats repérés au son (une image par moment, dans l’ordre) :',
      list,
      'Classe-les du plus spectaculaire au moins intéressant (coup final, combo, retournement, action lisible = mieux ; menus, chargements, écrans fixes = à rejeter).',
      'Donne les numéros d’images à garder dans l’ordre de préférence, et ceux à rejeter.',
    ].join('\n'),
    images,
    effort: 'medium',
    schema: {
      type: 'object', additionalProperties: false, required: ['keep', 'reject'],
      properties: {
        keep: { type: 'array', items: { type: 'integer' } },
        reject: { type: 'array', items: { type: 'integer' } },
      },
    },
  });
  const seen = new Set();
  const ranked = [];
  for (const n of out.keep || []) {
    const c = candidates[n - 1];
    if (c && !seen.has(n)) {
      seen.add(n);
      ranked.push(c);
    }
  }
  return ranked;
}

// ---- 4. Montage assistant ------------------------------------------------------------------

/** Applies a free-form request ("30 s max, only the Bryan combos, add a title") to a project. */
export async function direct({ project, data, catalog, instruction }) {
  const clips = catalog.map((c) => ({
    id: c.id, jeu: c.game, titre: c.title || null, tags: c.tags || null, duree: Number(c.duration.toFixed(1)),
    enregistre_le: c.recorded_at, moments_forts: (c.highlights || []).map((h) => ({ debut: h.start, fin: h.end, intensite: h.score })),
  }));
  const current = {
    format: data.format, fit: data.fit, fps: data.fps, transition: data.transition, transitionDuration: data.transitionDuration,
    grade: data.grade,
    segments: data.segments.map((s) => ({ clipId: s.clipId, start: s.start, end: s.end, speed: s.speed, impact: s.impact })),
    texts: data.texts.filter((t) => !t.auto).map(({ text, start, end, position, size }) => ({ text, start, end, position, size })),
  };
  const out = await askJson({
    system: `${SYSTEM}
Tu modifies un montage décrit en JSON. Règles :
- segments : extraits des clips fournis UNIQUEMENT (ce sont les vidéos que l'utilisateur a sélectionnées pour ce montage ; n'invente jamais d'autre clipId), 0 ≤ start < end ≤ durée du clip, dans l'ordre de lecture ; privilégie les moments forts fournis.
- Sauf si la demande dit le contraire, utilise chacun des clips fournis au moins une fois.
- textes : start/end en secondes sur la timeline du montage ; position top|center|bottom ; taille S|M|L.
- segments.speed : ${SPEEDS.join('|')} (0.5 = ralenti, idéal pour rejouer un moment fort juste après lui) ; segments.impact : seconde du clip où placer un effet d'impact (zoom + tremblement + flash, sur un kill, un but, un KO), ou null.
- format ${Object.keys(CANVAS).join('|')} ; fit ${FITS.join('|')} (follow = cadre 9:16 qui suit l'action, tous jeux ; stack = vue entière + zoom au centre, FPS/sport ; fight = jeux de combat) ; transition ${TRANSITIONS.join('|')} ; grade (étalonnage) ${Object.keys(GRADES).join('|')}.
- Ne garde que ce que la demande implique de changer ; explique en 1-2 phrases ce que tu as fait.`,
    prompt: [
      `Montage « ${project.name} » actuel :`, JSON.stringify(current),
      `Vidéos sélectionnées pour ce montage (${clips.length}) :`, JSON.stringify(clips),
      `Demande : ${instruction}`,
    ].join('\n'),
    effort: 'medium',
    schema: {
      type: 'object', additionalProperties: false,
      required: ['explanation', 'format', 'fit', 'fps', 'transition', 'transitionDuration', 'grade', 'segments', 'texts'],
      properties: {
        explanation: { type: 'string' },
        format: { type: 'string', enum: Object.keys(CANVAS) },
        fit: { type: 'string', enum: FITS },
        fps: { type: 'integer', enum: [30, 60] },
        transition: { type: 'string', enum: TRANSITIONS },
        transitionDuration: { type: 'number' },
        grade: { type: 'string', enum: Object.keys(GRADES) },
        segments: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['clipId', 'start', 'end', 'speed', 'impact'],
            properties: {
              clipId: { type: 'integer' }, start: { type: 'number' }, end: { type: 'number' },
              speed: { type: 'number', enum: SPEEDS }, impact: { type: ['number', 'null'] },
            },
          },
        },
        texts: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['text', 'start', 'end', 'position', 'size'],
            properties: {
              text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' },
              position: { type: 'string', enum: ['top', 'center', 'bottom'] }, size: { type: 'string', enum: ['S', 'M', 'L'] },
            },
          },
        },
      },
    },
  });

  const known = new Map(catalog.map((c) => [c.id, c]));
  const segments = (out.segments || []).filter((s) => known.has(s.clipId)).map((s) => {
    const clip = known.get(s.clipId);
    const start = Math.max(0, Math.min(Number(s.start) || 0, clip.duration - 0.5));
    return {
      clipId: s.clipId, start, end: Math.min(clip.duration, Math.max(Number(s.end) || clip.duration, start + 0.5)),
      speed: s.speed, impact: s.impact,
    };
  });
  if (!segments.length) throw new Error('L’IA n’a proposé aucun extrait valable, reformule ta demande');
  const next = sanitizeProjectData({
    ...data,
    format: out.format, fit: out.fit, fps: out.fps, transition: out.transition, transitionDuration: out.transitionDuration,
    grade: out.grade ?? data.grade,
    segments,
    // subtitles are kept as they are; regenerate them if the clips changed
    texts: [...data.texts.filter((t) => t.auto), ...(out.texts || []).map((t) => ({ ...t, box: true }))],
    pool: data.pool,
  });
  return { data: next, explanation: String(out.explanation || '') };
}
