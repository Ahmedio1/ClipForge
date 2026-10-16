// Pure geometry for the fighting-game layout: no I/O, unit-tested.

// Fighting-game screen regions (fractions of the source height)
export const HUD_FRAC = 0.105; // health bars, names, timer
export const BOTTOM_FRAC = 0.045; // replay control legend

/**
 * Union box of the characters in a list of detections (normalized coordinates), ignoring the
 * HUD portraits at the top and specks too small to be a fighter.
 */
export function fightersBox(detections, { minScore = 0.5, minArea = 0.01 } = {}) {
  const people = detections.filter((d) => d.label === 'person' && d.score >= minScore)
    .map((d) => d.box)
    .filter((b) => b.y1 > HUD_FRAC + 0.05 && (b.x1 - b.x0) * (b.y1 - b.y0) >= minArea);
  if (!people.length) return null;
  return [
    Math.min(...people.map((b) => b.x0)), Math.min(...people.map((b) => b.y0)),
    Math.max(...people.map((b) => b.x1)), Math.max(...people.map((b) => b.y1)),
  ];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Size of the zoomed gameplay window in the vertical layout (output pixels).
export const BOX_W = 1080;
export const BOX_H = 720;
const MAX_ZOOM = 1.25; // beyond this, upscaling gets visibly soft

/** Fills nulls from neighbours (average of the nearest on each side, else the one that exists). */
function fillGaps(values, fallback) {
  if (values.every((v) => v == null)) return values.map(() => fallback);
  return values.map((v, i) => {
    if (v != null) return v;
    const prev = values.slice(0, i).reverse().find((x) => x != null);
    const next = values.slice(i + 1).find((x) => x != null);
    return prev != null && next != null ? (prev + next) / 2 : (prev ?? next);
  });
}

const windowed = (values, fn) => values.map((_, i) => fn(values.slice(Math.max(0, i - 1), i + 2)));
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * Plans a "virtual camera" over one segment: per second, a zoom level (tight when the
 * characters are close, wide when they're apart) and the point to centre on.
 * The source is first cropped to the band between the HUD and the bottom legend; zoom applies
 * to that band, and cx/cy are fractions of it. Keyframe times are relative to the segment start.
 */
export function planCamera(samples, { start, end, srcW, srcH }) {
  const top = Math.round((srcH * HUD_FRAC) / 2) * 2;
  const bottom = Math.round((srcH * (1 - BOTTOM_FRAC)) / 2) * 2;
  const bandH = bottom - top;
  // +1 %: scaled sizes are truncated to even numbers and must still cover the box
  const zMin = Math.max(BOX_W / srcW, BOX_H / bandH) * 1.01;
  const zMax = Math.max(zMin, MAX_ZOOM);
  const inSeg = samples.filter((s) => s.sec >= Math.floor(start) && s.sec <= Math.ceil(end));

  const zooms = inSeg.map(({ box }) => {
    if (!box) return null;
    const needW = (box[2] - box[0]) * srcW * 1.15 + srcW * 0.05;
    const needH = (box[3] - box[1]) * srcH * 1.1;
    return clamp(Math.min(BOX_W / needW, BOX_H / needH), zMin, zMax);
  });
  const cxs = inSeg.map(({ box }) => (box ? (box[0] + box[2]) / 2 : null));
  const cys = inSeg.map(({ box }) => (box ? clamp((((box[1] + box[3]) / 2) * srcH - top) / bandH, 0, 1) : null));

  // Prefer the wider shot of neighbouring seconds (cutting a fighter is worse than zooming less),
  // then smooth everything so the camera glides.
  const z = windowed(windowed(fillGaps(zooms, zMin), (w) => Math.min(...w)), mean);
  const cx = windowed(fillGaps(cxs, 0.5), mean);
  const cy = windowed(fillGaps(cys, 0.5), mean);

  const keyframes = inSeg.map((s, i) => ({
    t: Math.max(0, s.sec + 0.5 - start),
    z: Number(z[i].toFixed(3)),
    cx: Number(cx[i].toFixed(3)),
    cy: Number(cy[i].toFixed(3)),
  }));
  if (!keyframes.length) keyframes.push({ t: 0, z: Number(zMin.toFixed(3)), cx: 0.5, cy: 0.5 });
  return {
    srcW, top, bandH, hudH: top, keyframes, tracked: inSeg.filter((s) => s.box).length,
  };
}

/** ffmpeg expression of t: piecewise-linear through keyframes[].field, flat outside. */
export function piecewise(keyframes, field) {
  const k = keyframes;
  if (k.length === 1) return String(k[0][field]);
  const T = (v) => v.toFixed(3);
  const parts = [`${k[0][field]}*lt(t,${T(k[0].t)})`];
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    const slope = (b[field] - a[field]) / Math.max(1e-3, b.t - a.t);
    parts.push(`(${a[field]}+(t-${T(a.t)})*${slope.toFixed(5)})*gte(t,${T(a.t)})*lt(t,${T(b.t)})`);
  }
  parts.push(`${k.at(-1)[field]}*gte(t,${T(k.at(-1).t)})`);
  return parts.join('+');
}

/** The filter chain turning a source frame into the BOX_W×BOX_H tracked, zoomed window. */
export function cameraFilter(cam) {
  const Z = piecewise(cam.keyframes, 'z');
  return [
    `crop=${cam.srcW}:${cam.bandH}:0:${cam.top}`,
    `scale=w='trunc(${cam.srcW}*(${Z})/2)*2':h='trunc(${cam.bandH}*(${Z})/2)*2':eval=frame`,
    `crop=${BOX_W}:${BOX_H}:'clip((${piecewise(cam.keyframes, 'cx')})*iw-${BOX_W / 2},0,iw-${BOX_W})'` +
      `:'clip((${piecewise(cam.keyframes, 'cy')})*ih-${BOX_H / 2},0,ih-${BOX_H})'`,
  ].join(',');
}

// ---- Generic "follow" reframing (any game) -----------------------------------------------

/**
 * Where the action is in one second of video, from frame differences: `frames` are grey
 * images (Uint8Array, w×h) a fraction of a second apart. Top and bottom bands (HUD, kill feed,
 * minimap labels) are ignored, and a soft centre prior keeps whole-screen camera pans centred.
 * Returns the horizontal centre of motion (0..1), or null when nothing moves.
 */
export function motionCentre(frames, w, h, { band = 0.12, noise = 14 } = {}) {
  if (frames.length < 2) return null;
  const cols = new Float64Array(w);
  const y0 = Math.floor(h * band);
  const y1 = Math.ceil(h * (1 - band));
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1];
    const b = frames[f];
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(a[y * w + x] - b[y * w + x]);
        if (d > noise) cols[x] += d;
      }
    }
  }
  let sum = 0;
  let weighted = 0;
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    const v = cols[x] * Math.exp(-(((u - 0.5) / 0.38) ** 2));
    sum += v;
    weighted += v * u;
  }
  // less than ~0.5 % of the analysed pixels changing noticeably: a still shot
  if (sum < (y1 - y0) * w * (frames.length - 1) * noise * 0.005) return null;
  return weighted / sum;
}

/**
 * Plans a horizontal 9:16 window over a segment from per-second motion centres
 * ([{ sec, cx }]): gaps filled, smoothed, and held still unless the action really moves,
 * so the frame doesn't wobble. Keyframe times are relative to the segment start.
 */
export function planFollow(samples, { start, end, deadZone = 0.05 }) {
  const inSeg = samples.filter((s) => s.sec >= Math.floor(start) && s.sec <= Math.ceil(end));
  const smoothed = windowed(windowed(fillGaps(inSeg.map((s) => s.cx), 0.5), mean), mean);
  let held = smoothed[0] ?? 0.5;
  const keyframes = inSeg.map((s, i) => {
    if (Math.abs(smoothed[i] - held) > deadZone) held = smoothed[i];
    return { t: Math.max(0, s.sec + 0.5 - start), cx: Number(held.toFixed(3)) };
  });
  if (!keyframes.length) keyframes.push({ t: 0, cx: 0.5 });
  return { keyframes, tracked: inSeg.filter((s) => s.cx != null).length };
}

/** Scales the source to the canvas height and crops a canvas-wide window that follows the action. */
export function followFilter(plan, W, H) {
  const cx = piecewise(plan?.keyframes || [{ t: 0, cx: 0.5 }], 'cx');
  return `scale=-2:${H},crop=${W}:${H}:'clip((${cx})*iw-${W / 2},0,iw-${W})':0`;
}
