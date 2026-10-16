import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const CANVAS = {
  landscape: { w: 1920, h: 1080 },
  vertical: { w: 1080, h: 1920 },
};
export const FITS = ['blur', 'crop', 'bars'];
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
    segments: [],
    texts: [],
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
    segments: (Array.isArray(input.segments) ? input.segments : [])
      .filter((s) => Number.isInteger(Number(s?.clipId)))
      .map((s) => ({
        id: String(s.id || Math.random().toString(36).slice(2, 10)),
        clipId: Number(s.clipId),
        start: num(s.start, 0, 1e6, 0),
        end: num(s.end, 0, 1e6, 0),
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
    music: input.music?.file
      ? { file: String(input.music.file), volume: num(input.music.volume, 0, 2, 0.5) }
      : null,
  };
}

/** Style fields a template carries (everything but the clips). */
export const STYLE_KEYS = ['format', 'fit', 'fps', 'transition', 'transitionDuration', 'fadeInOut', 'gameVolume', 'music'];

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
    name: 'YouTube classique',
    data: { format: 'landscape', fit: 'bars', fps: 60, transition: 'fade', transitionDuration: 0.6, fadeInOut: true, gameVolume: 1, music: null, texts: [] },
  },
];

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

/** Effective segments (clamped to clip duration, too-short ones dropped) and total length. */
export function planTimeline(data, clipsById) {
  const segments = data.segments
    .map((s) => {
      const clip = clipsById.get(s.clipId);
      if (!clip) return null;
      const start = Math.min(s.start, clip.duration);
      const end = Math.min(s.end > s.start ? s.end : clip.duration, clip.duration);
      return end - start >= 0.3 ? { ...s, start, end, dur: end - start, clip } : null;
    })
    .filter(Boolean);

  const useXfade = data.transition !== 'none' && segments.length > 1;
  const shortest = Math.min(...segments.map((s) => s.dur));
  const td = useXfade ? Math.min(data.transitionDuration, shortest / 2) : 0;
  const total = segments.reduce((t, s) => t + s.dur, 0) - td * Math.max(0, segments.length - 1);
  return { segments, td, useXfade, total };
}

/**
 * Builds the full ffmpeg argument list for a montage.
 * `textFiles` receives the text overlays' contents keyed by path to write before running
 * (drawtext reads from files so any user text is safe from filter escaping).
 */
export function buildMontageArgs(data, clipsById, { output, musicPath, musicDuration, textDir, fontPath = findFont() }) {
  const { w: W, h: H } = CANVAS[data.format];
  const { segments, td, useXfade, total } = planTimeline(data, clipsById);
  if (segments.length === 0) throw new Error('Le montage ne contient aucun clip');

  const args = ['-y', '-v', 'error'];
  const graph = [];
  const textFiles = {};

  segments.forEach((s, i) => {
    args.push('-ss', s.start.toFixed(3), '-t', s.dur.toFixed(3), '-i', s.clip.path);
    const norm = `fps=${data.fps},format=yuv420p,setsar=1,trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS,settb=AVTB`;
    if (data.fit === 'blur') {
      graph.push(
        `[${i}:v]split[bg${i}][fg${i}]`,
        `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgb${i}]`,
        `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs${i}]`,
        `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,${norm}[v${i}]`,
      );
    } else if (data.fit === 'crop') {
      graph.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${norm}[v${i}]`);
    } else {
      graph.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,${norm}[v${i}]`,
      );
    }
    const audioNorm = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `apad,atrim=0:${s.dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${data.gameVolume}`;
    graph.push(s.clip.has_audio
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
        `[0:a][mus]amix=inputs=2:duration=first:normalize=0[am]`,
        '-map', '0:v', '-map', '[am]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', total.toFixed(3), '-movflags', '+faststart', '-progress', 'pipe:1', output,
      ],
    });
  }
  return { passes, total, textFiles, tempFiles: withMusic ? [pass1Out] : [] };
}
