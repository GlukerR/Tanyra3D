import * as THREE from "three";

export const CAD_FORMATS = ["step", "stp", "iges", "igs", "brep"];

export const CAD_READERS: Record<string, string> = {
  step: "ReadStepFile",
  stp: "ReadStepFile",
  iges: "ReadIgesFile",
  igs: "ReadIgesFile",
  brep: "ReadBrepFile",
};

export const CAD_PARAMS = {
  linearUnit: "meter",
  linearDeflectionType: "bounding_box_ratio",
  linearDeflection: 0.001,
  angularDeflection: 0.5,
} as const;

const OCCT_BASE = "/vendor/occt/";

type Rgb = [number, number, number];
interface OcctMesh {
  name?: string;
  color?: Rgb;
  brep_faces?: Array<{ first: number; last: number; color: Rgb | null }>;
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } };
  index: { array: ArrayLike<number> };
}
interface OcctNode { name?: string; meshes?: number[]; children?: OcctNode[] }
interface OcctResult { success: boolean; root: OcctNode; meshes: OcctMesh[] }
type Occt = Record<string, (bytes: Uint8Array, params: unknown) => OcctResult>;

let occtReady: Promise<Occt> | null = null;

function loadOcct(): Promise<Occt> {
  if (occtReady) return occtReady;
  occtReady = new Promise<Occt>((resolve, reject) => {
    const w = window as unknown as { occtimportjs?: (o: object) => Promise<Occt> };
    const init = () => w.occtimportjs!({
      locateFile: (p: string) => OCCT_BASE + p,
      print: () => {},
      printErr: () => {},
    }).then(resolve, reject);
    if (w.occtimportjs) { init(); return; }
    const s = document.createElement("script");
    s.src = OCCT_BASE + "occt-import-js.js";
    s.onload = init;
    s.onerror = () => reject(new Error("occt-import-js failed to load"));
    document.head.appendChild(s);
  });
  occtReady.catch(() => { occtReady = null; });
  return occtReady;
}

export async function loadCad(buf: ArrayBuffer, format: string): Promise<THREE.Group> {
  const reader = CAD_READERS[format];
  if (!reader) throw new Error(`unsupported CAD format: ${format}`);
  const res = (await loadOcct())[reader]!(new Uint8Array(buf), CAD_PARAMS);
  if (!res || !res.success || !res.meshes?.length) throw new Error(`${format.toUpperCase()} unreadable`);

  const materials = new Map<string, THREE.Material>();
  const materialOf = (rgb: Rgb | null) => {
    const key = rgb ? rgb.map((v) => v.toFixed(6)).join(",") : "";
    let m = materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
      if (rgb) (m as THREE.MeshStandardMaterial).color.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
      materials.set(key, m);
    }
    return m;
  };

  const meshes = res.meshes.map((src, i) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(Array.from(src.attributes.position.array), 3));
    if (src.attributes.normal) geom.setAttribute("normal", new THREE.Float32BufferAttribute(Array.from(src.attributes.normal.array), 3));
    const total = Math.floor(src.index.array.length / 3);
    const colorOf: Array<Rgb | null> = new Array(total).fill(src.color || null);
    for (const f of src.brep_faces || []) {
      if (!f.color) continue;
      for (let t = f.first; t <= f.last && t < total; t++) colorOf[t] = f.color;
    }
    const order: number[] = [];
    const mats: THREE.Material[] = [];
    const byKey = new Map<string, number[]>();
    const keyColor = new Map<string, Rgb | null>();
    for (let t = 0; t < total; t++) {
      const c = colorOf[t] ?? null;
      const k = c ? c.map((v) => v.toFixed(6)).join(",") : "";
      if (!byKey.has(k)) { byKey.set(k, []); keyColor.set(k, c); }
      byKey.get(k)!.push(t);
    }
    for (const [k, tris] of byKey) {
      const start = order.length;
      for (const t of tris) order.push(src.index.array[t * 3]!, src.index.array[t * 3 + 1]!, src.index.array[t * 3 + 2]!);
      geom.addGroup(start, tris.length * 3, mats.length);
      mats.push(materialOf(keyColor.get(k) ?? null));
    }
    geom.setIndex(order);
    if (!src.attributes.normal) geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, mats.length === 1 ? mats[0]! : mats);
    mesh.name = src.name || `part_${i + 1}`;
    return mesh;
  });

  const build = (src: OcctNode): THREE.Object3D => {
    const g = new THREE.Group();
    g.name = src.name || "";
    for (const mi of src.meshes || []) g.add(meshes[mi]!.parent ? meshes[mi]!.clone() : meshes[mi]!);
    for (const c of src.children || []) g.add(build(c));
    return g;
  };
  const root = new THREE.Group();
  root.add(build(res.root));
  return root;
}
