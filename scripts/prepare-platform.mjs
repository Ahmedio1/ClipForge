// Adds another platform's native pieces next to the current ones, so the desktop app can be
// packaged for it from this machine: the FFmpeg binary (same release ffmpeg-static uses) and
// sharp's prebuilt package. Usage: node scripts/prepare-platform.mjs win32 x64
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const [platform, arch] = process.argv.slice(2);
if (!platform || !arch) throw new Error('usage: prepare-platform.mjs <win32|darwin|linux> <x64|arm64>');
const root = path.resolve(import.meta.dirname, '..');
const ffPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/ffmpeg-static/package.json'), 'utf8'));
const tag = ffPkg['ffmpeg-static']['binary-release-tag'];
const target = path.join(root, 'node_modules/ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

if (platform !== process.platform || !fs.existsSync(target)) {
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-${platform}-${arch}.gz`;
  console.log(`FFmpeg ${platform}-${arch} ← ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FFmpeg download failed: ${res.status}`);
  if (platform === process.platform) fs.writeFileSync(target, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())), { mode: 0o755 });
  else if (platform === 'win32') fs.writeFileSync(target, zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  else throw new Error('Only Windows can be prepared from another OS (the macOS/Linux binary name would clash)');
}

const sharpVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/sharp/package.json'), 'utf8')).version;
const sharpPkg = `@img/sharp-${platform}-${arch}`;
if (!fs.existsSync(path.join(root, 'node_modules', sharpPkg))) {
  console.log(`${sharpPkg}@${sharpVersion}`);
  // npm refuses to install another OS's package, but `npm pack` just downloads the tarball
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pack-'));
  const tgz = execFileSync('npm', ['pack', `${sharpPkg}@${sharpVersion}`, '--pack-destination', tmp], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').at(-1);
  const dest = path.join(root, 'node_modules', sharpPkg);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', dest, '--strip-components=1']);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`Prêt pour ${platform}-${arch}`);
