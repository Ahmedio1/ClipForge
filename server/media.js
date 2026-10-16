import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export { ffmpegPath };

export function run(bin, args, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onStdout?.(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `exit ${code}`));
    });
  });
}

export async function probe(file) {
  const out = await run(ffprobeStatic.path, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('Aucune piste vidéo');
  const duration = Number(info.format.duration || video.duration);
  if (!duration) throw new Error('Durée illisible (fichier en cours d’écriture ?)');
  return {
    duration,
    width: video.width,
    height: video.height,
    hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probeDuration(file) {
  const out = await run(ffprobeStatic.path, ['-v', 'error', '-print_format', 'json', '-show_format', file]);
  const duration = Number(JSON.parse(out).format?.duration);
  if (!duration) throw new Error('Durée illisible');
  return duration;
}

export function thumbnail(input, output, at) {
  return run(ffmpegPath, [
    '-y', '-v', 'error', '-ss', String(at), '-i', input,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output,
  ]);
}

const VIDEO_FILTERS = {
  original: null,
  // 9:16 for TikTok / Shorts / Reels: full frame over a blurred, zoomed copy of itself
  'vertical-blur':
    '[0:v]split[a][b];' +
    '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bg];' +
    '[b]scale=1080:-2[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]',
  // 9:16 centered crop
  'vertical-crop': '[0:v]scale=-2:1920,crop=1080:1920,setsar=1[v]',
};

export const FORMATS = Object.keys(VIDEO_FILTERS);

export function exportVideo({ input, output, start, end, format, mute, hasAudio }, onProgress) {
  const duration = end - start;
  const filter = VIDEO_FILTERS[format];
  const args = ['-y', '-v', 'error', '-ss', String(start), '-i', input, '-t', String(duration)];
  if (filter) args.push('-filter_complex', filter, '-map', '[v]');
  else args.push('-map', '0:v:0');
  if (!mute && hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-progress', 'pipe:1', output,
  );
  return runFfmpeg(args, duration, onProgress);
}

/** Runs ffmpeg with `-progress pipe:1` already in args, reporting 0..1 against `duration`. */
export function runFfmpeg(args, duration, onProgress) {
  return run(ffmpegPath, args, (text) => {
    const m = text.match(/out_time_us=(\d+)/g);
    if (!m) return;
    const us = Number(m.at(-1).split('=')[1]);
    onProgress?.(Math.max(0, Math.min(0.99, us / 1e6 / duration)));
  });
}
