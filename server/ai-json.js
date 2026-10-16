// Pure helper, unit-tested.

/** Pulls the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('Réponse de l’IA illisible (pas de JSON)');
  }
}
