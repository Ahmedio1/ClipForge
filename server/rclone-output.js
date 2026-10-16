// Parsing of rclone's machine-readable output (pure, unit-tested).

/** Parses the JSON rclone prints in --non-interactive config mode (after any log lines). */
export function parseConfigOutput(stdout) {
  const i = stdout.indexOf('{');
  if (i < 0) return null;
  return JSON.parse(stdout.slice(i));
}

/** The question part of a config step, trimmed to what the UI needs. */
export function toQuestion(step) {
  const o = step.Option;
  return {
    state: step.State,
    name: o.Name,
    help: o.Help,
    type: o.Type,
    password: !!o.IsPassword,
    default: o.DefaultStr ?? '',
    examples: (o.Examples || []).map((e) => ({ value: e.Value, label: e.Help })),
    exclusive: !!o.Exclusive,
    error: step.Error || '',
  };
}

/** Parses an rclone --use-json-log stats line into { progress, transfers }. */
export function parseStats(line) {
  try {
    const s = JSON.parse(line).stats;
    if (!s) return null;
    return {
      progress: s.totalBytes ? s.bytes / s.totalBytes : 0,
      transfers: s.transfers || 0,
      total: s.totalTransfers || 0,
    };
  } catch {
    return null;
  }
}
