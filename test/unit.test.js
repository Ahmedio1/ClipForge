import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCaptureName } from '../server/naming.js';
import { buildMontageArgs, planTimeline, sanitizeProjectData, wrapText } from '../server/montage.js';

test('parses recent Xbox Game Bar names', () => {
  assert.deepEqual(parseCaptureName('Valorant 2026-10-15 21-04-33.mp4'),
    { game: 'Valorant', recordedAt: '2026-10-15T21:04:33' });
  assert.deepEqual(parseCaptureName('Call of Duty® HQ 2026-01-02 08-09-10.mp4'),
    { game: 'Call of Duty® HQ', recordedAt: '2026-01-02T08:09:10' });
});

test('parses older Xbox Game Bar names with AM/PM', () => {
  assert.deepEqual(parseCaptureName('Rocket League 10_14_2026 9_15_02 PM.mp4'),
    { game: 'Rocket League', recordedAt: '2026-10-14T21:15:02' });
  assert.deepEqual(parseCaptureName('Minecraft 1_5_2026 12_00_00 AM.mp4'),
    { game: 'Minecraft', recordedAt: '2026-01-05T00:00:00' });
  assert.deepEqual(parseCaptureName('Minecraft 1_5_2026 12_30_00 PM.mp4'),
    { game: 'Minecraft', recordedAt: '2026-01-05T12:30:00' });
});

test('OBS names give a date but no game; unknown names give nothing', () => {
  assert.deepEqual(parseCaptureName('2026-10-13 18-30-00.mkv'), { game: null, recordedAt: '2026-10-13T18:30:00' });
  assert.deepEqual(parseCaptureName('mon clip.mp4'), { game: null, recordedAt: null });
});

test('wrapText wraps words, keeps newlines, splits long words', () => {
  assert.deepEqual(wrapText('un deux trois quatre', 9), ['un deux', 'trois', 'quatre']);
  assert.deepEqual(wrapText('a\nb c', 10), ['a', 'b c']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('sanitizeProjectData drops junk and clamps values', () => {
  const d = sanitizeProjectData({
    format: 'square', fit: 'nope', fps: 120, transition: 'explode', transitionDuration: 99, gameVolume: -3,
    segments: [{ clipId: 'x' }, { clipId: 4, start: -5, end: 3 }],
    texts: [{ text: 'hi', color: 'red', position: 'left', size: 'XXL' }, { nope: 1 }],
    music: { file: 'a.mp3', volume: 9 },
  });
  assert.equal(d.format, 'vertical');
  assert.equal(d.fit, 'blur');
  assert.equal(d.fps, 30);
  assert.equal(d.transition, 'fade');
  assert.equal(d.transitionDuration, 2);
  assert.equal(d.gameVolume, 0);
  assert.equal(d.segments.length, 1);
  assert.equal(d.segments[0].start, 0);
  assert.equal(d.texts.length, 1);
  assert.deepEqual([d.texts[0].color, d.texts[0].position, d.texts[0].size], ['#ffffff', 'bottom', 'M']);
  assert.equal(d.music.volume, 2);
});

const clips = new Map([
  [1, { id: 1, path: '/c/a.mp4', duration: 10, has_audio: 1 }],
  [2, { id: 2, path: '/c/b.mp4', duration: 4, has_audio: 0 }],
]);

test('planTimeline clamps to clip length, drops tiny segments and subtracts transitions', () => {
  const data = sanitizeProjectData({
    transition: 'fade', transitionDuration: 1,
    segments: [{ clipId: 1, start: 2, end: 6 }, { clipId: 2, start: 1, end: 50 }, { clipId: 2, start: 3.9, end: 4 }, { clipId: 9 }],
  });
  const plan = planTimeline(data, clips);
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[1].end, 4);
  assert.equal(plan.td, 1);
  assert.equal(plan.total, 4 + 3 - 1);
});

test('transition is capped at half the shortest segment', () => {
  const data = sanitizeProjectData({
    transition: 'fade', transitionDuration: 2,
    segments: [{ clipId: 1, start: 0, end: 5 }, { clipId: 2, start: 0, end: 1 }],
  });
  assert.equal(planTimeline(data, clips).td, 0.5);
});

test('buildMontageArgs chains xfade offsets and fills silent clips', () => {
  const data = sanitizeProjectData({
    transition: 'fade', transitionDuration: 0.5, fadeInOut: false,
    segments: [{ clipId: 1, start: 0, end: 3 }, { clipId: 2, start: 0, end: 2 }, { clipId: 1, start: 5, end: 9 }],
  });
  const { passes, total } = buildMontageArgs(data, clips, { output: '/o.mp4', textDir: '/t' });
  assert.equal(passes.length, 1);
  const graph = passes[0].args[passes[0].args.indexOf('-filter_complex') + 1];
  assert.match(graph, /xfade=transition=fade:duration=0\.500:offset=2\.500\[vx1\]/);
  assert.match(graph, /xfade=transition=fade:duration=0\.500:offset=4\.000\[vx2\]/);
  assert.match(graph, /anullsrc=r=48000:cl=stereo/); // clip 2 has no audio
  assert.equal(total, 3 + 2 + 4 - 1);
});

test('music adds a second pass that copies video', () => {
  const data = sanitizeProjectData({
    transition: 'none', segments: [{ clipId: 1, start: 0, end: 7 }], music: { file: 'm.mp3', volume: 0.5 },
  });
  const { passes, tempFiles } = buildMontageArgs(data, clips, {
    output: '/o.mp4', textDir: '/t', musicPath: '/m.mp3', musicDuration: 3,
  });
  assert.equal(passes.length, 2);
  assert.deepEqual(tempFiles, ['/o.mp4.pass1.mkv']);
  const a = passes[1].args;
  assert.equal(a[a.indexOf('-stream_loop') + 1], '2'); // 7s of a 3s track = 3 plays
  assert.equal(a[a.indexOf('-c:v') + 1], 'copy');
});

test('texts are written to files, never inlined into the filter graph', () => {
  const data = sanitizeProjectData({
    segments: [{ clipId: 1, start: 0, end: 5 }],
    texts: [{ text: "it's 100%: [hack];,", start: 0, end: 2 }],
  });
  const { passes, textFiles } = buildMontageArgs(data, clips, { output: '/o.mp4', textDir: '/t', fontPath: '/f.ttf' });
  const graph = passes[0].args[passes[0].args.indexOf('-filter_complex') + 1];
  assert.ok(!graph.includes('hack'));
  assert.deepEqual(Object.values(textFiles), ["it's 100%: [hack];,"]);
});

// ---- highlights, captions, templates ---------------------------------------------------

import { pickHighlights } from '../server/highlights.js';
import { groupCaptions } from '../server/captions.js';
import { applyTemplate, templateFromProject } from '../server/montage.js';

test('pickHighlights finds separated peaks, strongest first, leaning before the peak', () => {
  const curve = Array(80).fill(0); // 20 s at 0.25 s bins
  curve[20] = 10; // 5.125 s
  curve[21] = 9; // same moment, must be suppressed
  curve[60] = 6; // 15.125 s
  const h = pickHighlights(curve, 20);
  assert.equal(h.length, 2);
  assert.equal(h[0].time, 5.13);
  assert.equal(h[0].start, 1.13);
  assert.equal(h[0].end, 7.13);
  assert.equal(h[1].time, 15.13);
  assert.equal(h[1].end, 17.13);
});

test('pickHighlights returns nothing for a flat signal', () => {
  assert.deepEqual(pickHighlights(Array(40).fill(3), 10), []);
});

test('groupCaptions splits on word count, punctuation and pauses, never overlaps', () => {
  const w = (text, start, end) => ({ text, start, end });
  const caps = groupCaptions([
    w('un', 0, 0.2), w('deux', 0.2, 0.4), w('trois.', 0.4, 0.6),
    w('quatre', 0.7, 0.9), w('cinq', 0.9, 1.1), w('six', 1.1, 1.3), w('sept', 1.3, 1.5), w('huit', 1.5, 1.7),
    w('après', 4, 4.2), w('pause', 4.2, 4.4),
  ], { maxWords: 4 });
  assert.deepEqual(caps.map((c) => c.text), ['un deux trois.', 'quatre cinq six sept', 'huit', 'après pause']);
  for (let i = 0; i < caps.length - 1; i++) assert.ok(caps[i].end <= caps[i + 1].start);
  assert.ok(caps[2].end - caps[2].start >= 0.7 - 1e-9, 'short captions stay readable');
});

test('templates carry style and texts but never clips or subtitles', () => {
  const project = {
    format: 'landscape', fit: 'bars', transition: 'zoomin', segments: [{ clipId: 1, start: 0, end: 3 }],
    texts: [{ text: '@moi', start: 0, end: 9999 }, { text: 'auto sub', start: 1, end: 2, auto: true }],
  };
  const tpl = templateFromProject(project);
  assert.equal(tpl.segments, undefined);
  assert.deepEqual(tpl.texts.map((t) => t.text), ['@moi']);

  const target = { format: 'vertical', segments: [{ clipId: 7, start: 1, end: 2 }], texts: [{ text: 'sous-titre', start: 0, end: 1, auto: true }] };
  const merged = applyTemplate(target, tpl);
  assert.equal(merged.format, 'landscape');
  assert.equal(merged.transition, 'zoomin');
  assert.equal(merged.segments[0].clipId, 7);
  assert.deepEqual(merged.texts.map((t) => t.text).sort(), ['@moi', 'sous-titre']);
});

// ---- fight layout camera ------------------------------------------------------------

import { fightersBox, piecewise, planCamera } from '../server/camera.js';

/** Evaluates a piecewise() ffmpeg expression in JS. */
const evalExpr = (expr, t) => Function('t', `return ${expr
  .replace(/lt\(t,([\d.]+)\)/g, '(t<$1?1:0)')
  .replace(/gte\(t,([\d.]+)\)/g, '(t>=$1?1:0)')};`)(t);

test('fightersBox ignores HUD portraits and specks, unions the fighters', () => {
  const d = (x0, y0, x1, y1, label = 'person', score = 0.9) => ({ label, score, box: { x0, y0, x1, y1 } });
  assert.equal(fightersBox([d(0.01, 0, 0.05, 0.1)]), null, 'HUD portrait');
  assert.deepEqual(fightersBox([
    d(0.2, 0.3, 0.35, 0.9), d(0.6, 0.35, 0.8, 0.95), d(0.5, 0.5, 0.51, 0.51), d(0.1, 0.1, 0.9, 0.9, 'kite'),
  ]), [0.2, 0.3, 0.8, 0.95]);
});

test('camera zooms in on close fighters and out when they separate', () => {
  const src = { srcW: 1920, srcH: 1080 };
  const close = planCamera([0, 1, 2].map((sec) => ({ sec, box: [0.4, 0.4, 0.6, 0.9] })), { start: 0, end: 2, ...src });
  const far = planCamera([0, 1, 2].map((sec) => ({ sec, box: [0.02, 0.4, 0.98, 0.9] })), { start: 0, end: 2, ...src });
  assert.ok(close.keyframes.every((k) => k.z > 1), 'tight shot');
  assert.ok(far.keyframes.every((k) => k.z < 0.8), 'wide shot');
  assert.equal(close.keyframes[1].cx, 0.5);
  // the HUD band is cut off the top and the zoomed band always covers the 1080×720 box
  assert.equal(far.top, 114);
  assert.ok(far.keyframes.every((k) => 1920 * k.z >= 1080 && far.bandH * k.z >= 720));
});

test('camera fills detection gaps and follows the action sideways', () => {
  const cam = planCamera([
    { sec: 10, box: [0.1, 0.4, 0.3, 0.9] }, { sec: 11, box: null }, { sec: 12, box: [0.6, 0.4, 0.8, 0.9] },
  ], { start: 10, end: 12, srcW: 1920, srcH: 1080 });
  assert.equal(cam.keyframes.length, 3);
  assert.ok(cam.keyframes[0].cx < cam.keyframes[1].cx && cam.keyframes[1].cx < cam.keyframes[2].cx);
  assert.equal(cam.keyframes[0].t, 0.5);
});

test('piecewise expression interpolates between keyframes and holds outside', () => {
  const keys = [{ t: 0.5, z: 1 }, { t: 1.5, z: 2 }, { t: 2.5, z: 2 }];
  const e = piecewise(keys, 'z');
  assert.equal(evalExpr(e, 0), 1);
  assert.equal(evalExpr(e, 1), 1.5);
  assert.equal(evalExpr(e, 1.5), 2);
  assert.equal(evalExpr(e, 9), 2);
});

// ---- montage effects: speed, impacts, looks, beats, generic follow ------------------------

import { impactFilter, shapeBestOf } from '../server/montage.js';
import { motionCentre, planFollow, followFilter } from '../server/camera.js';
import { beatsFromEnvelope, loopBeats } from '../server/beats.js';

const graphOf = (out) => out.passes[0].args[out.passes[0].args.indexOf('-filter_complex') + 1];

test('new style fields and per-clip effects are sanitized', () => {
  const d = sanitizeProjectData({
    fit: 'follow', grade: 'cinema', progressBar: 1, beatSync: 'yes', duck: false,
    segments: [{ clipId: 1, start: 0, end: 2, speed: 0.5, impact: 1.2 }, { clipId: 1, speed: 3, impact: 'x' }],
  });
  assert.equal(d.fit, 'follow');
  assert.deepEqual([d.grade, d.progressBar, d.beatSync, d.duck], ['cinema', true, true, false]);
  assert.deepEqual(d.segments.map((s) => [s.speed, s.impact]), [[0.5, 1.2], [1, null]]);
  assert.equal(sanitizeProjectData({ grade: 'toString' }).grade, 'none', 'no prototype keys');
});

test('speed stretches a segment on the timeline and retimes video and audio', () => {
  const data = sanitizeProjectData({
    transition: 'none', fadeInOut: false,
    segments: [{ clipId: 1, start: 0, end: 2, speed: 0.5 }, { clipId: 1, start: 4, end: 8, speed: 2 }, { clipId: 1, start: 0, end: 1, speed: 0.25 }],
  });
  assert.deepEqual(planTimeline(data, clips).segments.map((s) => s.dur), [4, 2, 4]);
  const out = buildMontageArgs(data, clips, { output: '/o.mp4', textDir: '/t' });
  const graph = graphOf(out);
  assert.equal(out.total, 10);
  assert.match(graph, /setpts=\(PTS-STARTPTS\)\/0\.5,fps=30/);
  assert.match(graph, /atempo=0\.5,aresample/);
  assert.match(graph, /atempo=2,aresample/);
  assert.match(graph, /atempo=0\.5,atempo=0\.5,aresample/, '0.25× chains two atempo (min 0.5 each)');
  // the input reads the source span, not the timeline length
  assert.equal(out.passes[0].args[out.passes[0].args.indexOf('-t') + 1], '2.000');
});

test('impacts land at the right moment of a slowed segment; looks and progress bar are added', () => {
  const data = sanitizeProjectData({
    transition: 'none', grade: 'vivid', progressBar: true,
    segments: [{ clipId: 1, start: 2, end: 6, speed: 0.5, impact: 3 }],
  });
  const graph = graphOf(buildMontageArgs(data, clips, { output: '/o.mp4', textDir: '/t' }));
  // 1 s into the clip at half speed = 2 s into the segment
  assert.ok(graph.includes(impactFilter(2, 1080, 1920)));
  assert.match(graph, /eq=saturation=1\.3/);
  assert.match(graph, /color=c=0xffd23f:s=1080x13:r=30:d=8\.000\[pbar\]/);
  // an impact outside the segment is ignored
  const off = sanitizeProjectData({ segments: [{ clipId: 1, start: 2, end: 6, impact: 9 }] });
  assert.ok(!graphOf(buildMontageArgs(off, clips, { output: '/o.mp4', textDir: '/t' })).includes('eval=frame'));
});

test('9:16-only layouts fall back to bars in 16:9; follow and stack build their graphs', () => {
  const seg = [{ id: 's', clipId: 1, start: 0, end: 4 }];
  const land = graphOf(buildMontageArgs(sanitizeProjectData({ format: 'landscape', fit: 'stack', segments: seg }), clips, { output: '/o', textDir: '/t' }));
  assert.match(land, /pad=1920:1080/);
  const stack = graphOf(buildMontageArgs(sanitizeProjectData({ fit: 'stack', segments: seg }), clips, { output: '/o', textDir: '/t' }));
  assert.match(stack, /vstack/);
  const plan = planFollow([{ sec: 0, cx: 0.8 }, { sec: 1, cx: 0.8 }], { start: 0, end: 1 });
  const follow = graphOf(buildMontageArgs(sanitizeProjectData({ fit: 'follow', segments: seg }), clips, {
    output: '/o', textDir: '/t', follows: new Map([['s', plan]]),
  }));
  assert.ok(follow.includes(followFilter(plan, 1080, 1920)));
});

test('music ducking: the game sound drives a sidechain compressor on the music', () => {
  const base = { transition: 'none', segments: [{ clipId: 1, start: 0, end: 7 }], music: { file: 'm.mp3', volume: 0.5 } };
  const pass2 = (duck) => {
    const out = buildMontageArgs(sanitizeProjectData({ ...base, duck }), clips, {
      output: '/o.mp4', textDir: '/t', musicPath: '/m.mp3', musicDuration: 3,
    });
    return out.passes[1].args[out.passes[1].args.indexOf('-filter_complex') + 1];
  };
  assert.match(pass2(true), /\[mus\]\[g1\]sidechaincompress/);
  assert.ok(!pass2(false).includes('sidechaincompress'));
});

test('beat sync moves each cut to the nearest beat, within the clip', () => {
  const data = sanitizeProjectData({
    transition: 'none',
    segments: [{ clipId: 1, start: 0, end: 2.9 }, { clipId: 1, start: 0, end: 3.2 }, { clipId: 1, start: 0, end: 3 }],
  });
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7];
  const plan = planTimeline(data, clips, { beats });
  assert.deepEqual(plan.segments.map((s) => s.dur), [3, 3, 3]);
  assert.equal(plan.segments[0].end, 3, 'source end follows');
  // clip 2 is only 4 s long: a cut can't be pushed past its end
  const short = sanitizeProjectData({ transition: 'none', segments: [{ clipId: 2, start: 3.2, end: 4 }, { clipId: 1, start: 0, end: 2 }] });
  assert.ok(planTimeline(short, clips, { beats: [0, 1, 2] }).segments[0].end <= 4);
});

test('beat tracking finds the tempo and phase of a regular kick', () => {
  const hop = 256 / 11025;
  const env = Array.from({ length: 1500 }, (_, i) => {
    const t = i * hop;
    return (t - 0.3) >= 0 && ((t - 0.3) % 0.5) < hop ? 1 : 0.02 * Math.random();
  });
  const { bpm, beats } = beatsFromEnvelope(env);
  assert.ok(Math.abs(bpm - 120) < 1.5, `bpm ${bpm}`);
  assert.ok(Math.abs(beats[1] - 0.3) < 0.05 || Math.abs(beats[0] - 0.3) < 0.05, `phase ${beats.slice(0, 2)}`);
  assert.deepEqual(loopBeats([0.2, 1.2], 2, 5), [0.2, 1.2, 2.2, 3.2, 4.2]);
});

test('motion centre follows a moving object and ignores HUD bands and still frames', () => {
  const w = 40;
  const h = 20;
  const frame = (x, hudFlicker) => {
    const f = new Uint8Array(w * h);
    for (let y = 8; y < 12; y++) for (let i = x; i < x + 3; i++) f[y * w + i] = 255;
    if (hudFlicker) for (let i = 0; i < w; i++) f[i] = 255; // top row: HUD
    return f;
  };
  const cx = motionCentre([frame(28, 0), frame(30, 1), frame(32, 0)], w, h);
  assert.ok(cx > 0.65 && cx < 0.9, `cx ${cx}`);
  assert.equal(motionCentre([frame(10, 0), frame(10, 0)], w, h), null);
});

test('follow plan fills gaps, smooths, and holds still inside the dead zone', () => {
  const plan = planFollow([0.5, 0.52, null, 0.51, 0.9, 0.9, 0.9].map((cx, sec) => ({ sec, cx })), { start: 0, end: 6 });
  const xs = plan.keyframes.map((k) => k.cx);
  assert.equal(new Set(xs.slice(0, 3)).size, 1, 'small jitter is ignored');
  assert.ok(xs.at(-1) > 0.8, 'a real move is followed');
  assert.equal(plan.tracked, 6);
});

test('best-of shaping: impacts on peaks, crescendo order, slow-motion replay of the best', () => {
  const picks = [
    { clipId: 1, start: 0, end: 6, time: 4, score: 0.5 },
    { clipId: 2, start: 2, end: 8, time: 6, score: 1 },
    { clipId: 3, start: 1, end: 7, time: 5, score: 0.8 },
    { clipId: 4, start: 0, end: 6, time: 9, score: 0.3 },
  ];
  const segs = shapeBestOf(picks, { order: 'crescendo', replay: true });
  assert.deepEqual(segs.map((s) => s.clipId), [3, 4, 1, 2, 2]);
  assert.equal(segs[1].impact, null, 'a peak outside the cut gets no impact');
  assert.deepEqual(segs.at(-1), { clipId: 2, start: 4.5, end: 6.8, speed: 0.5, impact: 6 });
  assert.deepEqual(shapeBestOf(picks).map((s) => s.clipId), [1, 2, 3, 4], 'chrono by default, no replay');
});
