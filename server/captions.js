/**
 * Groups timed words into short on-screen captions (TikTok style): at most `maxWords`,
 * breaking early on sentence punctuation or a pause.
 */
export function groupCaptions(words, { maxWords = 4, maxGap = 0.6, minShow = 0.7 } = {}) {
  const captions = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    captions.push({
      text: cur.map((w) => w.text).join(' ').replace(/\s+([,.!?…])/g, '$1'),
      start: cur[0].start,
      end: Math.max(cur.at(-1).end, cur[0].start + minShow),
    });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || w.start - cur.at(-1).end > maxGap)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.text)) flush();
  }
  flush();
  // never overlap: a caption ends when the next one starts
  for (let i = 0; i < captions.length - 1; i++) {
    captions[i].end = Math.min(captions[i].end, captions[i + 1].start);
  }
  return captions.map((c) => ({ ...c, start: round(c.start), end: round(c.end) }));
}

const round = (n) => Math.round(n * 100) / 100;
