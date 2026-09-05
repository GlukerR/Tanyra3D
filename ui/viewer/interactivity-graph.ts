export type GraphValue = number[] | string | null;

export interface GraphHost {
  readPointer(path: string, type: string): GraphValue;
  writePointer(path: string, type: string, value: GraphValue): void;
  startAnimation(path: string, speed: number, startTime: number, endTime: number): void;
  stopAnimation(path: string): void;
  delay(seconds: number, run: () => void): void;
  log(message: string): void;
}

class UnknownOp extends Error {
  constructor(readonly op: string) {
    super(`KHR_interactivity: неизвестный узел графа «${op}»`);
    this.name = 'UnknownOp';
  }
}

interface RawNode {
  declaration: number;
  configuration?: Record<string, { value?: unknown[] }>;
  values?: Record<string, { type?: number; value?: unknown[]; node?: number; socket?: string }>;
  flows?: Record<string, { node?: number; socket?: string }>;
}

interface RawGraph {
  types?: Array<{ signature?: string }>;
  variables?: Array<{ id?: string; type?: number; value?: unknown[] }>;
  declarations?: Array<{ op?: string }>;
  nodes?: RawNode[];
}

const num = (v: GraphValue): number => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : 0);
const vec = (v: GraphValue): number[] => (Array.isArray(v) ? v : [0]);
const bool = (v: GraphValue): boolean => num(v) !== 0;

function pair(a: GraphValue, b: GraphValue, f: (x: number, y: number) => number): number[] {
  const av = vec(a);
  const bv = vec(b);
  const n = Math.max(av.length, bv.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(f(av[i] ?? av[0] ?? 0, bv[i] ?? bv[0] ?? 0));
  return out;
}

const map1 = (a: GraphValue, f: (x: number) => number): number[] => vec(a).map(f);

function quatMul(a: number[], b: number[]): number[] {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a;
  const [bx = 0, by = 0, bz = 0, bw = 1] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export class InteractivityGraph {
  private readonly graph: RawGraph;
  private readonly host: GraphHost;
  private readonly vars = new Map<string, GraphValue>();
  private memo = new Map<string, GraphValue>();
  private steps = 0;

  constructor(graph: RawGraph, host: GraphHost) {
    this.graph = graph;
    this.host = host;
    for (const v of graph.variables || []) {
      if (typeof v.id !== 'string') continue;
      const raw = v.value as unknown[] | undefined;
      if (Array.isArray(raw) && typeof raw[0] === 'string') this.vars.set(v.id, raw[0]);
      else this.vars.set(v.id, (raw as number[]) ?? [0]);
    }
  }

  unknownOps(): string[] {
    const out = new Set<string>();
    for (const node of this.graph.nodes || []) {
      const op = this.opOf(node);
      if (!KNOWN.has(op)) out.add(op || '(без имени)');
    }
    return [...out].sort();
  }

  selectorsFor(nodeIndex: number): number[] {
    const out: number[] = [];
    (this.graph.nodes || []).forEach((node, i) => {
      if (this.opOf(node) !== 'event/onSelect') return;
      const at = node.configuration?.['nodeIndex']?.value?.[0];
      if (at === nodeIndex) out.push(i);
    });
    return out;
  }

  start(): void {
    (this.graph.nodes || []).forEach((node, i) => {
      if (this.opOf(node) === 'event/onStart') this.fire(i);
    });
  }

  select(nodeIndex: number): boolean {
    const starts = this.selectorsFor(nodeIndex);
    for (const i of starts) this.fire(i);
    return starts.length > 0;
  }

  private fire(nodeIndex: number): void {
    this.memo = new Map();
    this.steps = 0;
    this.runFlow(nodeIndex, 'out');
  }

  private opOf(node: RawNode): string {
    return this.graph.declarations?.[node.declaration]?.op ?? '';
  }

  private signature(typeIndex: unknown): string {
    if (typeof typeIndex !== 'number') return 'float';
    return this.graph.types?.[typeIndex]?.signature ?? 'float';
  }


  private runFlow(nodeIndex: number, socket: string): void {
    const node = this.graph.nodes?.[nodeIndex];
    const next = node?.flows?.[socket];
    if (!next || typeof next.node !== 'number') return;
    this.exec(next.node);
  }

  private exec(nodeIndex: number): void {
    if (++this.steps > 10000) return;

    const node = this.graph.nodes?.[nodeIndex];
    if (!node) return;
    const op = this.opOf(node);
    this.memo = new Map();

    switch (op) {
      case 'pointer/set': {
        const type = this.signature(node.configuration?.['type']?.value?.[0]);
        const path = this.resolvePointer(nodeIndex);
        if (path) this.host.writePointer(path, type, this.input(nodeIndex, 'value'));
        this.runFlow(nodeIndex, 'out');
        return;
      }
      case 'variable/set': {
        const id = this.variableId(node, 'variables');
        const at = node.configuration?.['variables']?.value?.[0];
        const socket = typeof at === 'number' && node.values?.[String(at)] ? String(at) : '0';
        if (id) this.vars.set(id, this.input(nodeIndex, socket));
        this.runFlow(nodeIndex, 'out');
        return;
      }
      case 'flow/branch': {
        this.runFlow(nodeIndex, bool(this.input(nodeIndex, 'condition')) ? 'true' : 'false');
        return;
      }
      case 'flow/sequence': {
        for (const socket of Object.keys(node.flows || {}).sort()) this.runFlow(nodeIndex, socket);
        return;
      }
      case 'flow/setDelay': {
        const seconds = num(this.input(nodeIndex, 'duration'));
        this.host.delay(seconds, () => {
          this.memo = new Map();
          this.steps = 0;
          this.runFlow(nodeIndex, 'done');
        });
        return;
      }
      case 'animation/start': {
        const anim = this.input(nodeIndex, 'animation');
        if (typeof anim === 'string') {
          this.host.startAnimation(
            anim,
            num(this.input(nodeIndex, 'speed')) || 1,
            num(this.input(nodeIndex, 'startTime')),
            num(this.input(nodeIndex, 'endTime')),
          );
        }
        this.runFlow(nodeIndex, 'out');
        return;
      }
      case 'animation/stop': {
        const anim = this.input(nodeIndex, 'animation');
        if (typeof anim === 'string') this.host.stopAnimation(anim);
        this.runFlow(nodeIndex, 'out');
        return;
      }
      case 'debug/log': {
        const text = node.configuration?.['message']?.value?.[0];
        this.host.log(typeof text === 'string' ? text : 'debug/log');
        this.runFlow(nodeIndex, 'out');
        return;
      }
      default:
        if (op === 'event/onSelect' || op === 'event/onStart') { this.runFlow(nodeIndex, 'out'); return; }
        throw new UnknownOp(op);
    }
  }


  private input(nodeIndex: number, socket: string): GraphValue {
    const slot = this.graph.nodes?.[nodeIndex]?.values?.[socket];
    if (!slot) return null;
    if (typeof slot.node === 'number') return this.output(slot.node, slot.socket ?? 'value');
    const raw = slot.value;
    if (!Array.isArray(raw)) return null;
    if (typeof raw[0] === 'string') return raw[0];
    return raw as number[];
  }

  private output(nodeIndex: number, socket: string): GraphValue {
    const key = nodeIndex + ':' + socket;
    const seen = this.memo.get(key);
    if (seen !== undefined) return seen;

    const value = this.compute(nodeIndex, socket);
    this.memo.set(key, value);
    return value;
  }

  private compute(nodeIndex: number, socket: string): GraphValue {
    const node = this.graph.nodes?.[nodeIndex];
    if (!node) return null;
    const op = this.opOf(node);
    const a = () => this.input(nodeIndex, 'a');
    const b = () => this.input(nodeIndex, 'b');
    const c = () => this.input(nodeIndex, 'c');

    switch (op) {
      case 'math/add': return pair(a(), b(), (x, y) => x + y);
      case 'math/sub': return pair(a(), b(), (x, y) => x - y);
      case 'math/mul': return pair(a(), b(), (x, y) => x * y);
      case 'math/div': return pair(a(), b(), (x, y) => (y === 0 ? 0 : x / y));
      case 'math/rem': return pair(a(), b(), (x, y) => (y === 0 ? 0 : x % y));
      case 'math/abs': return map1(a(), Math.abs);
      case 'math/floor': return map1(a(), Math.floor);
      case 'math/sin': return map1(a(), Math.sin);
      case 'math/cos': return map1(a(), Math.cos);
      case 'math/rad': return map1(a(), (x) => (x * Math.PI) / 180);
      case 'math/Inf': return [Infinity];
      case 'math/random': return [Math.random()];
      case 'math/eq': return [num(a()) === num(b()) ? 1 : 0];
      case 'math/lt': return [num(a()) < num(b()) ? 1 : 0];
      case 'math/le': return [num(a()) <= num(b()) ? 1 : 0];
      case 'math/clamp': return pair(a(), b(), (x, y) => Math.max(x, y))
        .map((x, i) => Math.min(x, vec(c())[i] ?? vec(c())[0] ?? x));
      case 'math/mix': {
        const t = num(c());
        return pair(a(), b(), (x, y) => x + (y - x) * t);
      }
      case 'math/quatMul': return quatMul(vec(a()), vec(b()));
      case 'math/combine2': return [num(a()), num(b())];
      case 'math/combine3': return [num(a()), num(b()), num(c())];
      case 'math/combine4': return [num(a()), num(b()), num(c()), num(this.input(nodeIndex, 'd'))];
      case 'math/extract2':
      case 'math/extract3': {
        const src = vec(a());
        const at = Number(socket);
        return [Number.isFinite(at) ? (src[at] ?? 0) : (src[0] ?? 0)];
      }
      case 'math/switch': {
        const cases = node.configuration?.['cases']?.value as unknown[] | undefined;
        const selection = num(this.input(nodeIndex, 'selection'));
        const at = Array.isArray(cases) ? cases.indexOf(selection) : -1;
        const chosen = at >= 0 ? this.input(nodeIndex, String(at)) : null;
        return chosen ?? this.input(nodeIndex, 'default');
      }
      case 'type/intToFloat': return [num(a())];
      case 'type/floatToInt': return [Math.trunc(num(a()))];
      case 'variable/get': {
        const id = this.variableId(node, 'variable');
        return (id && this.vars.get(id)) ?? null;
      }
      case 'pointer/get': {
        const type = this.signature(node.configuration?.['type']?.value?.[0]);
        const path = this.resolvePointer(nodeIndex);
        return path ? this.host.readPointer(path, type) : null;
      }
      case 'event/onSelect':
        return socket === 'selectedNode' ? this.selectedNode : null;
      default:
        throw new UnknownOp(op);
    }
  }

  private selectedNode: GraphValue = null;

  setSelected(path: string | null): void {
    this.selectedNode = path;
  }

  private variableId(node: RawNode, key: string): string | null {
    const at = node.configuration?.[key]?.value?.[0];
    if (typeof at !== 'number') return null;
    return this.graph.variables?.[at]?.id ?? null;
  }

  private resolvePointer(nodeIndex: number): string | null {
    const raw = this.graph.nodes?.[nodeIndex]?.configuration?.['pointer']?.value?.[0];
    if (typeof raw !== 'string') return null;
    let out = raw;
    for (const match of raw.matchAll(/\{([^}]+)\}/g)) {
      const socket = match[1] ?? '';
      const ref = this.input(nodeIndex, socket);
      const at = typeof ref === 'string'
        ? /(\d+)\s*$/.exec(ref)?.[1]
        : (Array.isArray(ref) && typeof ref[0] === 'number' ? String(ref[0]) : undefined);
      if (at === undefined || at === null) return null;
      out = out.replace(match[0], at);
    }
    return out;
  }
}

const KNOWN = new Set([
  'event/onSelect', 'event/onStart',
  'flow/branch', 'flow/sequence', 'flow/setDelay',
  'pointer/get', 'pointer/set',
  'variable/get', 'variable/set',
  'animation/start', 'animation/stop',
  'type/intToFloat', 'type/floatToInt',
  'debug/log',
  'math/add', 'math/sub', 'math/mul', 'math/div', 'math/rem', 'math/abs', 'math/floor',
  'math/sin', 'math/cos', 'math/rad', 'math/Inf', 'math/random', 'math/eq', 'math/lt',
  'math/le', 'math/clamp', 'math/mix', 'math/quatMul', 'math/combine2', 'math/combine3',
  'math/combine4', 'math/extract2', 'math/extract3', 'math/switch',
]);
