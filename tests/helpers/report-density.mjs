export const DENSITY_WHITELIST = new Set(['engine.skipped.line']);

export const DENSITY_LIMIT = 3;

export function densityViolations(result) {
  const counts = new Map();
  for (const list of [result.applied, result.skipped, result.findings, result.validation]) {
    for (const rec of list) {
      const id = rec.i18n?.text?.messageId;
      if (!id || DENSITY_WHITELIST.has(id)) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > DENSITY_LIMIT);
}
