import * as THREE from "three";

import { type GraphHost, type GraphValue, InteractivityGraph } from "./interactivity-graph.js";

const SUPPORTED = [
  /^\/nodes\/\{?[^/]*\}?\/(translation|rotation|scale)$/,
  /^\/nodes\/\{?[^/]*\}?\/extensions\/KHR_node_visibility\/visible$/,
  /^\/nodes\/\{?[^/]*\}?\/extensions\/KHR_node_selectability\/selectable$/,
  /^\/materials\/\{?[^/]*\}?\/pbrMetallicRoughness\/baseColorFactor$/,
  /^\/materials\/\{?[^/]*\}?\/pbrMetallicRoughness\/baseColorTexture\/extensions\/KHR_texture_transform\/(offset|scale)$/,
  /^\/animations\/\{?[^/]*\}?$/,
  /^\/animations\/\{?[^/]*\}?\/extensions\/KHR_interactivity\/maxTime$/,
];

const supported = (path: string) => SUPPORTED.some((re) => re.test(path));

const indexOf = (path: string, kind: string): number => {
  const m = new RegExp('^/' + kind + '/(\\d+)').exec(path);
  return m ? Number(m[1]) : -1;
};

const truthy = (v: GraphValue): boolean => {
  if (Array.isArray(v)) return Boolean(v[0]);
  return Boolean(v);
};

export interface RuntimeDeps {
  nodes: Map<number, THREE.Object3D>;
  materials: Map<number, THREE.Material>;
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer | null;
  redraw: () => void;
  setClickable: (nodeIndex: number, on: boolean) => void;
}

export class InteractivityRuntime implements GraphHost {
  private readonly graph: InteractivityGraph;
  private readonly deps: RuntimeDeps;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly selectable = new Map<number, boolean>();
  private dead = false;

  readonly refusal: string[];

  constructor(graphJson: unknown, deps: RuntimeDeps) {
    this.deps = deps;
    this.graph = new InteractivityGraph(graphJson as never, this);

    const ops = this.graph.unknownOps();
    const paths = this.unsupportedPointers(graphJson);
    this.refusal = [...ops, ...paths];
  }

  private unsupportedPointers(graphJson: unknown): string[] {
    const graph = graphJson as { nodes?: Array<{ configuration?: Record<string, { value?: unknown[] }> }> };
    const out = new Set<string>();
    for (const node of graph?.nodes || []) {
      const raw = node.configuration?.['pointer']?.value?.[0];
      if (typeof raw !== 'string') continue;
      if (!supported(raw)) out.add(raw);
    }
    return [...out].sort();
  }

  start(): void {
    if (this.refusal.length || this.dead) return;
    this.graph.start();
  }

  select(nodeIndex: number): boolean {
    if (this.refusal.length || this.dead) return false;
    this.graph.setSelected('/nodes/' + nodeIndex);
    const было = this.graph.select(nodeIndex);
    if (было) this.deps.redraw();
    return было;
  }

  dispose(): void {
    this.dead = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  readPointer(path: string, _type: string): GraphValue {
    if (path.startsWith('/animations/')) {
      if (path.endsWith('/maxTime')) {
        const clip = this.deps.clips[indexOf(path, 'animations')];
        return [clip ? clip.duration : 0];
      }
      return path;
    }
    if (path.startsWith('/nodes/')) {
      const obj = this.deps.nodes.get(indexOf(path, 'nodes'));
      if (!obj) return null;
      if (path.endsWith('/translation')) return [obj.position.x, obj.position.y, obj.position.z];
      if (path.endsWith('/scale')) return [obj.scale.x, obj.scale.y, obj.scale.z];
      if (path.endsWith('/rotation')) {
        const q = obj.quaternion;
        return [q.x, q.y, q.z, q.w];
      }
      if (path.endsWith('/visible')) return [obj.visible ? 1 : 0];
      if (path.endsWith('/selectable')) {
        return [this.selectable.get(indexOf(path, 'nodes')) === false ? 0 : 1];
      }
      return null;
    }
    if (path.startsWith('/materials/')) {
      const mat = this.deps.materials.get(indexOf(path, 'materials')) as THREE.MeshStandardMaterial | undefined;
      if (!mat) return null;
      if (path.endsWith('/baseColorFactor')) {
        return [mat.color.r, mat.color.g, mat.color.b, mat.opacity];
      }
      const map = mat.map;
      if (!map) return null;
      if (path.endsWith('/offset')) return [map.offset.x, map.offset.y];
      if (path.endsWith('/scale')) return [map.repeat.x, map.repeat.y];
    }
    return null;
  }

  writePointer(path: string, _type: string, value: GraphValue): void {
    const v = Array.isArray(value) ? value : [0];
    if (path.startsWith('/nodes/')) {
      const obj = this.deps.nodes.get(indexOf(path, 'nodes'));
      if (!obj) return;
      if (path.endsWith('/translation')) obj.position.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
      else if (path.endsWith('/scale')) obj.scale.set(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1);
      else if (path.endsWith('/rotation')) obj.quaternion.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
      else if (path.endsWith('/visible')) obj.visible = truthy(value);
      else if (path.endsWith('/selectable')) {
        const at = indexOf(path, 'nodes');
        this.selectable.set(at, truthy(value));
        this.deps.setClickable(at, truthy(value));
      }
      this.deps.redraw();
      return;
    }
    if (path.startsWith('/materials/')) {
      const mat = this.deps.materials.get(indexOf(path, 'materials')) as THREE.MeshStandardMaterial | undefined;
      if (!mat) return;
      if (path.endsWith('/baseColorFactor')) {
        mat.color.setRGB(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1);
        const alpha = v[3] ?? 1;
        if (alpha < 1) mat.transparent = true;
        mat.opacity = alpha;
        mat.needsUpdate = true;
      } else if (mat.map && path.endsWith('/offset')) {
        mat.map.offset.set(v[0] ?? 0, v[1] ?? 0);
      } else if (mat.map && path.endsWith('/scale')) {
        mat.map.repeat.set(v[0] ?? 1, v[1] ?? 1);
      }
      this.deps.redraw();
    }
  }

  startAnimation(path: string, speed: number, startTime: number, endTime: number): void {
    const clip = this.deps.clips[indexOf(path, 'animations')];
    if (!clip || !this.deps.mixer) return;
    const action = this.deps.mixer.clipAction(clip);
    action.reset();
    action.timeScale = speed || 1;
    action.time = startTime || 0;
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    if (endTime > 0 && endTime < clip.duration) action.setDuration(endTime - (startTime || 0));
    action.play();
    this.deps.redraw();
  }

  stopAnimation(path: string): void {
    const clip = this.deps.clips[indexOf(path, 'animations')];
    if (!clip || !this.deps.mixer) return;
    this.deps.mixer.clipAction(clip).stop();
    this.deps.redraw();
  }

  delay(seconds: number, run: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.dead) return;
      try {
        run();
      } catch (e) {
        console.warn('KHR_interactivity: отложенный шаг не выполнен —', e);
      }
      this.deps.redraw();
    }, Math.max(0, seconds * 1000));
    this.timers.add(t);
  }

  log(message: string): void {
    console.log('[KHR_interactivity]', message);
  }
}
