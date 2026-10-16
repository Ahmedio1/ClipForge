import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.CLIPFORGE_DATA ? path.resolve(process.env.CLIPFORGE_DATA) : path.join(ROOT, 'data');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
export const MUSIC_DIR = path.join(DATA_DIR, 'music');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

for (const dir of [DATA_DIR, THUMBS_DIR, EXPORTS_DIR, MUSIC_DIR]) fs.mkdirSync(dir, { recursive: true });

const defaults = {
  // Same location Xbox Game Bar uses on Windows: %USERPROFILE%\Videos\Captures
  clipsDir: process.env.CLIPFORGE_CLIPS || path.join(os.homedir(), 'Videos', 'Captures'),
};

let config = { ...defaults };
try {
  config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch {
  // first run: keep defaults
}
fs.mkdirSync(config.clipsDir, { recursive: true });

export function getConfig() {
  return { ...config };
}

export function updateConfig(patch) {
  config = { ...config, ...patch };
  fs.mkdirSync(config.clipsDir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return getConfig();
}
