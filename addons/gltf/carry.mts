const POINTER_RE = /^\/([A-Za-z_][A-Za-z_0-9]*)\/(?:\d|\{)/;

export function arraysAddressedBy(value: unknown): Set<string> | null {
  const names = new Set<string>();
  let sawString = false;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('/')) {
        sawString = true;
        const m = POINTER_RE.exec(v);
        if (m && m[1]) names.add(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return sawString && names.size ? names : null;
}

export function addressesNothing(value: unknown): boolean {
  let clean = true;
  const walk = (v: unknown) => {
    if (!clean) return;
    if (typeof v === 'number') { clean = false; return; }
    if (typeof v === 'string') { if (/^\s*-?\d+\s*$/.test(v)) clean = false; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return clean;
}

export function hasOpaqueExtension(json: unknown, names: readonly string[]): string[] {
  if (!names.length) return [];
  const искомые = new Set(names);
  const непрозрачные = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'extensions' && val && typeof val === 'object') {
        for (const [имя, тело] of Object.entries(val as Record<string, unknown>)) {
          if (!искомые.has(имя)) continue;
          if (addressesNothing(тело)) continue;
          if (arraysAddressedBy(тело) === null) непрозрачные.add(имя);
        }
      }
      walk(val);
    }
  };
  walk(json);
  return [...непрозрачные].sort();
}
