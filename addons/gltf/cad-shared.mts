export const CAD_FORMATS = ['step', 'stp', 'iges', 'igs', 'brep'] as const;

export const CAD_READERS: Record<string, string> = {
  step: 'ReadStepFile',
  stp: 'ReadStepFile',
  iges: 'ReadIgesFile',
  igs: 'ReadIgesFile',
  brep: 'ReadBrepFile',
};

export const CAD_PARAMS = {
  linearUnit: 'meter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
} as const;

type Rgb = [number, number, number];

export interface OcctMesh {
  name?: string;
  color?: Rgb;
  brep_faces?: Array<{ first: number; last: number; color: Rgb | null }>;
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
}

export interface OcctNode {
  name?: string;
  meshes?: number[];
  children?: OcctNode[];
}

export interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

export function groupFacesByColor(m: OcctMesh): Array<{ color: Rgb | null; triangles: number[] }> {
  const total = Math.floor(m.index.array.length / 3);
  const base = m.color || null;
  const colorOf = new Array<Rgb | null>(total).fill(base);
  for (const f of m.brep_faces || []) {
    if (!f.color) continue;
    for (let t = f.first; t <= f.last && t < total; t++) colorOf[t] = f.color;
  }
  const groups = new Map<string, { color: Rgb | null; triangles: number[] }>();
  for (let t = 0; t < total; t++) {
    const c = colorOf[t] ?? null;
    const key = c ? c.map((v) => v.toFixed(6)).join(',') : '';
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { color: c, triangles: [] }));
    g.triangles.push(t);
  }
  return [...groups.values()];
}
