import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BOX_H, BOX_W, cameraFilter, followFilter, planCamera } from './camera.js';
import { LOUDNORM } from './media.js';

export const CANVAS = {
  landscape: { w: 1920, h: 1080 },
  vertical: { w: 1080, h: 1920 },
};
// follow = 9:16 window that tracks the action; stack = full view on top, centre zoom below (FPS)
export const FITS = ['blur', 'crop', 'bars', 'follow', 'stack', 'fight'];
/** Fits that only make sense in 9:16; in 16:9 they fall back to black bars. */
const VERTICAL_FITS = ['follow', 'stack', 'fight'];
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2];
// Colour looks, applied to the whole montage (texts stay true to their colour)
export const GRADES = {
  none: null,
  vivid: 'eq=saturation=1.3:contrast=1.06,unsharp=5:5:0.5',
  punchy: 'eq=contrast=1.18:saturation=1.22:gamma=0.96,unsharp=5:5:0.8',
  cinema: 'curves=preset=medium_contrast,colorbalance=rs=-0.04:bs=0.06:rh=0.06:bh=-0.05,eq=saturation=0.92,vignette=PI/5',
  retro: 'curves=preset=vintage,noise=alls=7:allf=t',
  bw: 'hue=s=0,eq=contrast=1.15',
};
export const TRANSITIONS = ['none', 'fade', 'fadeblack', 'dissolve', 'wipeleft', 'slideleft', 'circleopen', 'zoomin'];
const TEXT_SIZES = { S: 0.05, M: 0.075, L: 0.11 };
const TEXT_POSITIONS = ['top', 'center', 'bottom'];

export function defaultProjectData() {
  return {
    format: 'vertical',
    fit: 'blur',
    fps: 30,
    transition: 'fade',
    transitionDuration: 0.5,
    fadeInOut: true,
    gameVolume: 1,
    grade: 'none',
    progressBar: false,
    beatSync: false, // cuts snap to the music's beat
    duck: true, // music dips while the game is loud
    segments: [],
    texts: [],
    pool: [],
    music: null, // { file, volume }
  };
}

const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Coerces untrusted project JSON into a valid shape, dropping anything unknown. */
export function sanitizeProjectData(input = {}) {
  const d = defaultProjectData();
  return {
    format: CANVAS[input.format] ? input.format : d.format,
    fit: FITS.includes(input.fit) ? input.fit : d.fit,
    fps: [30, 60].includes(Number(input.fps)) ? Number(input.fps) : d.fps,
    transition: TRANSITIONS.includes(input.transition) ? input.transition : d.transition,
    transitionDuration: num(input.transitionDuration, 0.1, 2, d.transitionDuration),
    fadeInOut: input.fadeInOut !== undefined ? !!input.fadeInOut : d.fadeInOut,
    gameVolume: num(input.gameVolume, 0, 2, d.gameVolume),
    grade: Object.hasOwn(GRADES, input.grade) ? input.grade : d.grade,
    progressBar: input.progressBar !== undefined ? !!input.progressBar : d.progressBar,
    beatSync: input.beatSync !== undefined ? !!input.beatSync : d.beatSync,
    duck: input.duck !== undefined ? !!input.duck : d.duck,
    segments: (Array.isArray(input.segments) ? input.segments : [])
      .filter((s) => Number.isInteger(Number(s?.clipId)))
      .map((s) => ({
        id: String(s.id || Math.random().toString(36).slice(2, 10)),
        clipId: Number(s.clipId),
        start: num(s.start, 0, 1e6, 0),
        end: num(s.end, 0, 1e6, 0),
        speed: SPEEDS.includes(Number(s.speed)) ? Number(s.speed) : 1,
        // clip time of the "impact" (zoom punch + shake + flash), usually the highlight peak
        impact: s.impact != null && Number.isFinite(Number(s.impact)) ? num(s.impact, 0, 1e6, 0) : null,
      })),
    texts: (Array.isArray(input.texts) ? input.texts : [])
      .filter((t) => typeof t?.text === 'string')
      .map((t) => ({
        id: String(t.id || Math.random().toString(36).slice(2, 10)),
        text: t.text.slice(0, 300),
        start: num(t.start, 0, 1e6, 0),
        end: num(t.end, 0, 1e6, 3),
        position: TEXT_POSITIONS.includes(t.position) ? t.position : 'bottom',
        size: TEXT_SIZES[t.size] ? t.size : 'M',
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#ffffff',
        box: t.box !== undefined ? !!t.box : true,
        auto: !!t.auto, // generated subtitle, replaced on regeneration
      })),
    // the videos the user picked for this montage: the AI assistant works with these only
    pool: [...new Set((Array.isArray(input.pool) ? input.pool : []).map(Number).filter(Number.isInteger))],
    music: input.music?.file
      ? { file: String(input.music.file), volume: num(input.music.volume, 0, 2, 0.5) }
      : null,
  };
}

/** Style fields a template carries (everything but the clips). */
export const STYLE_KEYS = ['format', 'fit', 'fps', 'transition', 'transitionDuration', 'fadeInOut', 'gameVolume', 'music',
  'grade', 'progressBar', 'beatSync', 'duck'];

/** A template's data: style plus its non-subtitle texts (an `end` ≥ 9999 means "until the end"). */
export function templateFromProject(data) {
  const clean = sanitizeProjectData(data);
  const out = Object.fromEntries(STYLE_KEYS.map((k) => [k, clean[k]]));
  out.texts = clean.texts.filter((t) => !t.auto);
  return out;
}

export function applyTemplate(data, template) {
  const base = sanitizeProjectData(data);
  const tpl = sanitizeProjectData({ ...base, ...template, segments: [] });
  const merged = { ...base, ...Object.fromEntries(STYLE_KEYS.map((k) => [k, tpl[k]])) };
  if (template.texts?.length) {
    const fresh = tpl.texts.map((t) => ({ ...t, id: Math.random().toString(36).slice(2, 10) }));
    merged.texts = [...base.texts.filter((t) => t.auto), ...fresh];
  }
  return merged;
}

export const BUILTIN_TEMPLATES = [
  {
    name: 'TikTok dynamique',
    data: { format: 'vertical', fit: 'crop', fps: 60, transition: 'slideleft', transitionDuration: 0.3, fadeInOut: true, gameVolume: 1, music: null, texts: [] },
  },
  {
    name: 'Best-of flou',
    data: { format: 'vertical', fit: 'blur', fps: 30, transition: 'fadeblack', transitionDuration: 0.5, fadeInOut: true, gameVolume: 1, music: null, texts: [] },
  },
  {
    name: 'Combat (Tekken, Street Fighter…)',
    data: { format: 'vertical', fit: 'fight', fps: 60, transition: 'fade', transitionDuration: 0.2, fadeInOut: true, gameVolume: 1, music: null, texts: [] },
  },
  {
    name: 'FPS / Battle royale (Valorant, CoD, Fortnite…)',
    data: { format: 'vertical', fit: 'stack', fps: 60, transition: 'fade', transitionDuration: 0.25, fadeInOut: true, gameVolume: 1, grade: 'vivid', progressBar: true, music: null, texts: [] },
  },
  {
    name: 'Sport / Course (FC, Rocket League, Forza…)',
    data: { format: 'vertical', fit: 'follow', fps: 60, transition: 'slideleft', transitionDuration: 0.3, fadeInOut: true, gameVolume: 1, grade: 'vivid', progressBar: true, music: null, texts: [] },
  },
  {
    name: 'Edit sur le beat',
    data: { format: 'vertical', fit: 'follow', fps: 60, transition: 'none', transitionDuration: 0.3, fadeInOut: true, gameVolume: 0.8, grade: 'punchy', beatSync: true, duck: true, progressBar: false, music: null, texts: [] },
  },
  {
    name: 'Cinématique (aventure, RPG)',
    data: { format: 'landscape', fit: 'bars', fps: 30, transition: 'fadeblack', transitionDuration: 0.8, fadeInOut: true, gameVolume: 1, grade: 'cinema', music: null, texts: [] },
  },
  {
    name: 'YouTube classique',
    data: { format: 'landscape', fit: 'bars', fps: 60, transition: 'fade', transitionDuration: 0.6, fadeInOut: true, gameVolume: 1, music: null, texts: [] },
  },
];

/**
 * Finishing touches of a best-of. picks: [{ clipId, start, end, time, score }].
 * Every moment gets an impact on its peak; `order: 'crescendo'` opens on the 2nd best moment
 * (the hook), builds up and ends on the best one; `replay` adds a slow-motion replay of it.
 */
export function shapeBestOf(picks, { order = 'chrono', replay = false } = {}) {
  let out = picks.map((p) => ({
    clipId: p.clipId, start: p.start, end: p.end, score: p.score ?? 0,
    impact: p.time != null && p.time >= p.start && p.time <= p.end ? p.time : null,
  }));
  if (order === 'crescendo' && out.length > 2) {
    const byScore = [...out].sort((a, b) => a.score - b.score);
    const best = byScore.pop();
    const hook = byScore.pop();
    out = [hook, ...byScore, best];
  }
  if (replay && out.length) {
    const best = out.reduce((b, p) => (p.score > b.score ? p : b));
    const peak = best.impact ?? (best.start + best.end) / 2;
    out.splice(out.indexOf(best) + 1, 0, {
      clipId: best.clipId, start: Math.max(best.start, peak - 1.5), end: Math.min(best.end, peak + 0.8),
      speed: 0.5, impact: best.impact,
    });
  }
  return out.map(({ score, ...seg }) => seg);
}

let cachedFont;
export function findFont() {
  if (cachedFont !== undefined) return cachedFont;
  const candidates = [];
  try {
    candidates.push(execFileSync('fc-match', ['-f', '%{file}', 'sans:bold'], { encoding: 'utf8' }).trim());
  } catch {
    // no fontconfig (Windows/macOS)
  }
  candidates.push(
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
  );
  cachedFont = candidates.find((f) => f && fs.existsSync(f)) || null;
  return cachedFont;
}

/** Greedy word wrap; explicit newlines are kept, over-long words are split. */
export function wrapText(text, maxChars) {
  const out = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > maxChars) {
        if (line) out.push(line);
        out.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
        line = '';
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Escapes a value for use inside a single-quoted ffmpeg filter option. */
function filterPath(p) {
  return `'${p.replace(/\\/g, '/').replace(/'/g, "'\\\\''").replace(/:/g, '\\:')}'`;
}

/**
 * Fighting-game vertical layout for one segment: blurred backdrop, the HUD (health bars) as a
 * full-width band, and below it a zoomed window that follows the characters.
 */
function fightLayout(i, seg, plan, { W, H, norm }) {
  const srcW = seg.clip.width || 1920;
  const srcH = seg.clip.height || 1080;
  const cam = plan || planCamera([], { start: seg.start, end: seg.end, srcW, srcH });
  const even = (n) => Math.round(n / 2) * 2;
  const hudOut = even((W * cam.hudH) / srcW);
  const gameH = even((W * BOX_H) / BOX_W);
  const gap = 12;
  const block = hudOut + gap + gameH;
  // a bit above centre, leaving room for a hook title on top and subtitles below
  const top = even(Math.max(H * 0.14, Math.min(H - block, (H - block) / 2 - H * 0.03)));
  return [
    `[${i}:v]setpts=PTS-STARTPTS,split=3[fa${i}][fb${i}][fc${i}]`,
    `[fa${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.2:saturation=0.85[bg${i}]`,
    `[fb${i}]crop=${srcW}:${cam.hudH}:0:0,scale=${W}:${hudOut}[hud${i}]`,
    `[fc${i}]${cameraFilter(cam)},scale=${W}:${gameH}[gm${i}]`,
    `[bg${i}][hud${i}]overlay=0:${top}[bh${i}]`,
    `[bh${i}][gm${i}]overlay=0:${top + hudOut + gap},${norm}[v${i}]`,
  ];
}

/** Full view on top, the centre of the screen (crosshair, ball, car) zoomed in below. */
function stackLayout(i, seg, { W, H, norm }) {
  const srcW = seg.clip.width || 1920;
  const srcH = seg.clip.height || 1080;
  const even = (n) => Math.round(n / 2) * 2;
  const topH = even((W * srcH) / srcW);
  const zoomH = H - topH;
  const ch = even(srcH * 0.72);
  const cw = Math.min(srcW, even((ch * W) / zoomH));
  return [
    `[${i}:v]setpts=PTS-STARTPTS,split[sa${i}][sb${i}]`,
    `[sa${i}]scale=${W}:${topH}[st${i}]`,
    `[sb${i}]crop=${cw}:${ch}:(iw-${cw})/2:(ih-${ch})/2,scale=${W}:${zoomH}[sz${i}]`,
    `[st${i}][sz${i}]vstack,drawbox=x=0:y=${topH - 3}:w=${W}:h=6:color=black@0.85:t=fill,${norm}[v${i}]`,
  ];
}

/**
 * Zoom punch + shake + white flash around `T` (seconds into the segment): a fast attack and
 * a slower release, so a hit or a kill "lands".
 */
export function impactFilter(T, W, H) {
  const t = T.toFixed(3);
  const env = `if(lt(t,${t}),exp(-pow((t-${t})/0.07,2)),exp(-(t-${t})/0.4))`;
  // clamped so the window never leaves the zoomed frame: (room = scaled size - canvas size) / 2
  const shake = (dim, size, amp, freq) => `max(-(${dim}-${size})/2,min((${dim}-${size})/2,${amp}*${env}*sin(t*${freq})))`;
  return [
    `scale=w='trunc(${W}*(1+0.16*${env})/2)*2':h='trunc(${H}*(1+0.16*${env})/2)*2':eval=frame`,
    `crop=${W}:${H}:'(iw-${W})/2+${shake('iw', W, 14, 95)}':'(ih-${H})/2+${shake('ih', H, 10, 83)}'`,
    `eq=brightness='0.28*gte(t,${t})*exp(-(t-${t})/0.07)':eval=frame`,
  ].join(',');
}

const atempo = (speed) => {
  const parts = [];
  let s = speed;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  if (s !== 1) parts.push(`atempo=${s}`);
  return parts.length ? `${parts.join(',')},` : '';
};

/**
 * Moves every cut (except the last) to the nearest beat, never past the end of its clip and
 * never shorter than the transition needs. Changes `dur`/`end` in place.
 */
function snapToBeats(segments, beats, td) {
  let pos = 0;
  for (let k = 0; k < segments.length - 1; k++) {
    const seg = segments[k];
    const natural = pos + seg.dur - td; // where the next clip starts showing
    const maxDur = (seg.clip.duration - seg.start) / seg.speed;
    const minDur = Math.max(2 * td + 0.05, Math.min(seg.dur, 1));
    let best = null;
    for (const b of beats) {
      const d = b - pos + td;
      if (d < minDur || d > maxDur) continue;
      if (best == null || Math.abs(b - natural) < Math.abs(best - natural)) best = b;
    }
    if (best != null && Math.abs(best - natural) < 1.5) {
      seg.dur = best - pos + td;
      seg.end = seg.start + seg.dur * seg.speed;
    }
    pos += seg.dur - td;
  }
}

/** Effective segments (clamped to clip duration, too-short ones dropped) and total length. */
export function planTimeline(data, clipsById, { beats } = {}) {
  const segments = data.segments
    .map((s) => {
      const clip = clipsById.get(s.clipId);
      if (!clip) return null;
      const start = Math.min(s.start, clip.duration);
      const end = Math.min(s.end > s.start ? s.end : clip.duration, clip.duration);
      const speed = s.speed || 1;
      return end - start >= 0.3 ? { ...s, speed, start, end, dur: (end - start) / speed, clip } : null;
    })
    .filter(Boolean);

  const useXfade = data.transition !== 'none' && segments.length > 1;
  const shortest = Math.min(...segments.map((s) => s.dur));
  const td = useXfade ? Math.min(data.transitionDuration, shortest / 2) : 0;
  if (beats?.length) snapToBeats(segments, beats, td);
  const total = segments.reduce((t, s) => t + s.dur, 0) - td * Math.max(0, segments.length - 1);
  return { segments, td, useXfade, total };
}

/**
 * Builds the full ffmpeg argument list for a montage.
 * `textFiles` receives the text overlays' contents keyed by path to write before running
 * (drawtext reads from files so any user text is safe from filter escaping).
 */
export function buildMontageArgs(data, clipsById, {
  output, musicPath, musicDuration, textDir, cameras = new Map(), follows = new Map(), beats, fontPath = findFont(),
}) {
  const { w: W, h: H } = CANVAS[data.format];
  const { segments, td, useXfade, total } = planTimeline(data, clipsById, { beats });
  if (segments.length === 0) throw new Error('Le montage ne contient aucun clip');

  const args = ['-y', '-v', 'error'];
  const graph = [];
  const textFiles = {};

  segments.forEach((s, i) => {
    // the source span is (end - start); on the timeline it lasts dur = span / speed
    args.push('-ss', s.start.toFixed(3), '-t', (s.end - s.start).toFixed(3), '-i', s.clip.path);
    const hit = s.impact != null && s.impact >= s.start && s.impact <= s.end
      ? `,${impactFilter((s.impact - s.start) / s.speed, W, H)}` : '';
    const norm = `setpts=(PTS-STARTPTS)/${s.speed},fps=${data.fps},format=yuv420p,setsar=1,` +
      `trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS,settb=AVTB${hit}`;
    const fit = VERTICAL_FITS.includes(data.fit) && data.format !== 'vertical' ? 'bars' : data.fit;
    if (fit === 'fight') {
      graph.push(...fightLayout(i, s, cameras.get(s.id), { W, H, norm }));
    } else if (fit === 'stack') {
      graph.push(...stackLayout(i, s, { W, H, norm }));
    } else if (fit === 'follow') {
      graph.push(`[${i}:v]setpts=PTS-STARTPTS,${followFilter(follows.get(s.id), W, H)},${norm}[v${i}]`);
    } else if (fit === 'blur') {
      graph.push(
        `[${i}:v]split[bg${i}][fg${i}]`,
        `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgb${i}]`,
        `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${i}]`,
        `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,${norm}[v${i}]`,
      );
    } else if (fit === 'crop') {
      graph.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${norm}[v${i}]`);
    } else {
      graph.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,${norm}[v${i}]`,
      );
    }
    const audioNorm = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `apad,atrim=0:${s.dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${data.gameVolume}`;
    graph.push(s.clip.has_audio && s.speed !== 1
      ? `[${i}:a]asetpts=PTS-STARTPTS,${atempo(s.speed)}${audioNorm}[a${i}]`
      : s.clip.has_audio
      ? `[${i}:a]${audioNorm}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,${audioNorm}[a${i}]`);
  });

  // Join segments
  let vLabel;
  let aLabel;
  if (segments.length === 1) {
    vLabel = 'v0';
    aLabel = 'a0';
  } else if (!useXfade) {
    graph.push(`${segments.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segments.length}:v=1:a=1[vj][aj]`);
    vLabel = 'vj';
    aLabel = 'aj';
  } else {
    let offset = 0;
    vLabel = 'v0';
    aLabel = 'a0';
    for (let i = 1; i < segments.length; i++) {
      offset += segments[i - 1].dur - td;
      graph.push(`[${vLabel}][v${i}]xfade=transition=${data.transition}:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[vx${i}]`);
      graph.push(`[${aLabel}][a${i}]acrossfade=d=${td.toFixed(3)}[ax${i}]`);
      vLabel = `vx${i}`;
      aLabel = `ax${i}`;
    }
  }

  const grade = GRADES[data.grade];
  if (grade) {
    graph.push(`[${vLabel}]${grade}[vg]`);
    vLabel = 'vg';
  }

  // Text overlays
  const texts = data.texts.filter((t) => t.text.trim() && t.start < total);
  if (texts.length) {
    if (!fontPath) throw new Error('Aucune police trouvée pour les textes');
    const chain = [];
    texts.forEach((t, i) => {
      const size = Math.round(Math.min(W, H) * TEXT_SIZES[t.size]);
      const lines = wrapText(t.text, Math.floor((W * 0.9) / (size * 0.56)));
      const pad = Math.round(size * 0.25);
      const lineH = Math.round(size * 1.2 + (t.box ? pad * 2 : 0));
      const blockH = lineH * lines.length;
      const baseY = { top: `h*0.08`, center: `(h-${blockH})/2`, bottom: `h*0.86-${blockH}` }[t.position];
      const end = Math.min(t.end, total);
      lines.forEach((line, j) => {
        // One drawtext per line keeps every line centered (ffmpeg 6.0 has no text_align).
        const file = `${textDir}/text-${i}-${j}.txt`;
        textFiles[file] = line;
        chain.push(
          `drawtext=fontfile=${filterPath(fontPath)}:textfile=${filterPath(file)}:expansion=none` +
          `:fontsize=${size}:fontcolor=${t.color}:bordercolor=black` +
          `:borderw=${t.box ? 0 : Math.max(2, Math.round(size / 16))}` +
          `:box=${t.box ? 1 : 0}:boxcolor=black@0.55:boxborderw=${pad}` +
          `:x=(w-text_w)/2:y=${baseY}+${j * lineH + (t.box ? pad : 0)}` +
          `:enable='between(t,${t.start.toFixed(2)},${end.toFixed(2)})'`,
        );
      });
    });
    graph.push(`[${vLabel}]${chain.join(',')}[vt]`);
    vLabel = 'vt';
  }

  if (data.progressBar) {
    const bh = Math.round(H * 0.007);
    // a bar sliding in from the left (drawbox's size isn't re-evaluated per frame in ffmpeg 6.0)
    graph.push(`color=c=0xffd23f:s=${W}x${bh}:r=${data.fps}:d=${total.toFixed(3)}[pbar]`);
    graph.push(`[${vLabel}][pbar]overlay=x='-w+W*t/${total.toFixed(3)}':y=H-${bh}:eof_action=pass[vp]`);
    vLabel = 'vp';
  }

  // Global fade in/out
  if (data.fadeInOut && total > 2) {
    const d = 0.4;
    const st = (total - d).toFixed(3);
    graph.push(`[${vLabel}]fade=t=in:st=0:d=${d},fade=t=out:st=${st}:d=${d}[vf]`);
    graph.push(`[${aLabel}]afade=t=in:st=0:d=${d},afade=t=out:st=${st}:d=${d}[af]`);
    vLabel = 'vf';
    aLabel = 'af';
  }

  // With music, pass 1 keeps lossless audio in a temp .mkv and pass 2 mixes the music in
  // while copying the video. Mixing a looped input in the main graph can deadlock
  // ffmpeg's scheduler when a segment runs to its clip's very end.
  const withMusic = !!(data.music && musicPath && musicDuration);
  if (!withMusic) {
    graph.push(`[${aLabel}]${LOUDNORM}[aln]`);
    aLabel = 'aln';
  }
  const pass1Out = withMusic ? `${output}.pass1.mkv` : output;
  args.push(
    '-filter_complex', graph.join(';'),
    '-map', `[${vLabel}]`, '-map', `[${aLabel}]`,
    '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(data.fps),
    ...(withMusic ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']),
    '-progress', 'pipe:1', pass1Out,
  );
  const passes = [{ args, duration: total, weight: withMusic ? 0.93 : 1 }];

  if (withMusic) {
    const fade = data.fadeInOut && total > 2
      ? `,afade=t=in:st=0:d=0.4,afade=t=out:st=${(total - 0.4).toFixed(3)}:d=0.4`
      : '';
    passes.push({
      duration: total,
      weight: 0.07,
      args: [
        '-y', '-v', 'error', '-i', pass1Out,
        // A finite loop count: `-stream_loop -1` with `-t` hangs when `total` lands on a loop boundary.
        '-stream_loop', String(Math.max(0, Math.ceil(total / musicDuration) - 1)), '-i', musicPath,
        '-filter_complex',
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${data.music.volume}${fade}[mus];` +
        (data.duck
          // the game's sound pushes the music down (hits, voice), then lets it back up
          ? `[0:a]asplit=2[g1][g2];[mus][g1]sidechaincompress=threshold=0.05:ratio=6:attack=15:release=400[md];` +
            `[g2][md]amix=inputs=2:duration=first:normalize=0,${LOUDNORM}[am]`
          : `[0:a][mus]amix=inputs=2:duration=first:normalize=0,${LOUDNORM}[am]`),
        '-map', '0:v', '-map', '[am]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', total.toFixed(3), '-movflags', '+faststart', '-progress', 'pipe:1', output,
      ],
    });
  }
  return { passes, total, segments, textFiles, tempFiles: withMusic ? [pass1Out] : [] };
}
