import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const cleanGame = (s) => s.replace(/[\s_-]+$/, '').trim() || null;

/**
 * Xbox Game Bar names clips "<Game> <date> <time>.mp4", in one of two formats:
 *   recent: "Valorant 2026-10-15 21-04-33.mp4"
 *   older:  "Valorant 10_15_2026 9_04_33 PM.mp4"
 * OBS's default "2026-10-15 21-04-33.mkv" matches the first with no game.
 */
export function parseCaptureName(filename) {
  const base = path.parse(filename).name;

  let m = base.match(/^(.*?)[\s_-]*(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    return { game: cleanGame(m[1]), recordedAt: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}` };
  }

  m = base.match(/^(.*?)\s+(\d{1,2})_(\d{1,2})_(\d{4})\s+(\d{1,2})_(\d{2})_(\d{2})\s*(AM|PM)?/i);
  if (m) {
    let hour = Number(m[5]);
    const meridiem = m[8]?.toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
    return {
      game: cleanGame(m[1]),
      recordedAt: `${m[4]}-${pad(m[2])}-${pad(m[3])}T${pad(hour)}:${m[6]}:${m[7]}`,
    };
  }

  return { game: null, recordedAt: null };
}
