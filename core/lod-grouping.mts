export interface LodCandidate {
  name: string;
  triangles: number;
  texturePixels: number;
  size: readonly [number, number, number];
  center: readonly [number, number, number];
}

export interface LodGroup {
  source: 'names' | 'measured';
  order: number[];
}

const LOD_NAME = /(?:^|[^a-z])lod[_\s-]?(\d+)/i;

const LOD_STEP = 2;

const LOD_MIN_STRICT = 3;
const LOD_MIN_NAMED = 2;

const AXES = [0, 1, 2] as const;

const descending = (s: readonly [number, number, number]) =>
  [s[0], s[1], s[2]].sort((a, b) => b - a) as [number, number, number];

function placedAsLevels(centers: ReadonlyArray<readonly [number, number, number]>, span: number): boolean {
  const slack = span * 0.2;
  const spread = AXES.map((a) => {
    const v = centers.map((c) => c[a]);
    return Math.max(...v) - Math.min(...v);
  });

  if (spread.every((s) => s <= slack)) return true;

  const wide = spread.filter((s) => s > slack);
  if (wide.length !== 1) return false;
  const axis = AXES[spread.indexOf(wide[0]!)]!;

  const line = centers.map((c) => c[axis]).sort((a, b) => a - b);
  const steps: number[] = [];
  for (let i = 1; i < line.length; i++) steps.push(line[i]! - line[i - 1]!);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  if (!(mean > 0)) return false;
  return steps.every((s) => Math.abs(s - mean) <= mean * 0.25);
}

function оценить(cands: readonly LodCandidate[], strict: boolean): number[] | null {
  if (cands.length < (strict ? LOD_MIN_STRICT : LOD_MIN_NAMED)) return null;

  const order = cands.map((_, i) => i).sort((a, b) =>
    cands[b]!.triangles - cands[a]!.triangles
    || cands[b]!.texturePixels - cands[a]!.texturePixels);

  const seen = new Set(order.map((i) => cands[i]!.triangles + '/' + cands[i]!.texturePixels));
  if (seen.size !== order.length) return null;

  const ref = cands[order[0]!]!;
  const refSize = descending(ref.size);
  if (!refSize[0]) return null;

  if (strict) {
    for (let i = 1; i < order.length; i++) {
      const выше = cands[order[i - 1]!]!;
      const ниже = cands[order[i]!]!;

      const step = выше.triangles === ниже.triangles
        ? (ниже.texturePixels ? выше.texturePixels / ниже.texturePixels : Infinity)
        : (ниже.triangles ? выше.triangles / ниже.triangles : Infinity);
      if (step < LOD_STEP) return null;

      if (ниже.texturePixels > выше.texturePixels) return null;
    }
  }

  const tol = strict ? 0.1 : 0.2;
  for (const i of order) {
    const s = descending(cands[i]!.size);
    if (Math.abs(s[0] - refSize[0]) > Math.max(s[0], refSize[0]) * tol) return null;
    if (s[1] > refSize[1] * (1 + tol)) return null;
  }

  if (strict && !placedAsLevels(order.map((i) => cands[i]!.center), refSize[0])) return null;

  return order;
}

export function groupLevels(cands: readonly LodCandidate[]): LodGroup | null {
  if (cands.length < LOD_MIN_NAMED) return null;

  const named: number[] = [];
  cands.forEach((c, i) => { if (LOD_NAME.test(c.name)) named.push(i); });

  if (named.length >= LOD_MIN_NAMED) {
    const inner = оценить(named.map((i) => cands[i]!), false);
    if (inner) return { source: 'names', order: inner.map((k) => named[k]!) };
  }

  const order = оценить(cands, true);
  return order ? { source: 'measured', order } : null;
}
