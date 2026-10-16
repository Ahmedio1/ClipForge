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
