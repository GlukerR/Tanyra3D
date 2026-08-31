// ui/viewer/interactivity-runtime.ts — связь графа поведения с настоящей сценой.
//
// Вычислитель (`interactivity-graph.ts`) знает только числа и адреса вида
// `/materials/3/pbrMetallicRoughness/baseColorFactor`. Здесь адреса превращаются в
// свойства three.js, а нажатие мышью — в событие графа.
//
// ЧТО ПОДДЕРЖАНО И ПОЧЕМУ ИМЕННО ЭТО. Не «всё, что бывает в спецификации», а ровно те
// девять видов адресов, которые встречаются в наборе Khronos — они и измерены:
//
//   28 /nodes/{}/rotation                    7 /nodes/{}/translation
//   27 /materials/{}/…/baseColorFactor       5 /nodes/{}/…/KHR_node_visibility/visible
//   14 /animations/{}/…/maxTime              5 /nodes/{}/…/KHR_node_selectability/selectable
//    2 /materials/{}/…/KHR_texture_transform/offset и столько же /scale
//
// Адрес, которого нет в этом списке, — такой же повод отказаться целиком, как и
// незнакомый узел графа: половинчатое проигрывание хуже отсутствия. Проверка идёт ДО
// первого нажатия (`unsupported`), а не посреди него.
//
// ГРАНИЦА (Правило 11). Всё, что здесь делается, живёт в СЦЕНЕ ПРОСМОТРА и в файл не
// попадает ни байтом: сдвинутый узел, погашенная видимость, перекрашенный материал —
// это показ поведения, а не правка модели. Собранный файл увозит исходные значения.

import * as THREE from "three";

import { type GraphHost, type GraphValue, InteractivityGraph } from "./interactivity-graph.js";

/** Адреса, которые мы умеем читать и писать. Проверяются по шаблону, без номеров. */
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

/** Номер из адреса: `/materials/3/…` → 3. */
const indexOf = (path: string, kind: string): number => {
  const m = new RegExp('^/' + kind + '/(\\d+)').exec(path);
  return m ? Number(m[1]) : -1;
};

const truthy = (v: GraphValue): boolean => {
  if (Array.isArray(v)) return Boolean(v[0]);
  return Boolean(v);
};

export interface RuntimeDeps {
  /** Узлы сцены по номеру из файла. */
  nodes: Map<number, THREE.Object3D>;
  /** Материалы по номеру из файла. */
  materials: Map<number, THREE.Material>;
  clips: THREE.AnimationClip[];
  mixer: THREE.AnimationMixer | null;
  /** Перерисовать кадр: граф меняет сцену вне цикла отрисовки. */
  redraw: () => void;
  /**
   * Граф погасил или вернул нажимаемость узлу.
   *
   * Это не косметика: `"selectable": false` — решение автора, и часть, которую он
   * выключил, не должна откликаться на нажатие и не должна быть обведена. У калькулятора
   * граф гасит узел при каждом нажатии.
   */
  setClickable: (nodeIndex: number, on: boolean) => void;
}

export class InteractivityRuntime implements GraphHost {
  private readonly graph: InteractivityGraph;
  private readonly deps: RuntimeDeps;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private dead = false;

  /** Почему интерактив не проигрывается. Пусто — проигрывается. */
  readonly refusal: string[];

  constructor(graphJson: unknown, deps: RuntimeDeps) {
    this.deps = deps;
    this.graph = new InteractivityGraph(graphJson as never, this);

    // Отказ решается ДО первого нажатия и целиком: и по узлам, и по адресам.
    const ops = this.graph.unknownOps();
    const paths = this.unsupportedPointers(graphJson);
    this.refusal = [...ops, ...paths];
  }

  /** Адреса графа, которых мы не умеем. Читаются из настроек узлов, до исполнения. */
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

  /** Запустить то, что начинается само. Ничего не делает, если есть отказ. */
  start(): void {
    if (this.refusal.length || this.dead) return;
    this.graph.start();
  }

  /** Человек нажал на узел сцены. `false` — этот узел графу неинтересен. */
  select(nodeIndex: number): boolean {
    if (this.refusal.length || this.dead) return false;
    this.graph.setSelected('/nodes/' + nodeIndex);
    const было = this.graph.select(nodeIndex);
    if (было) this.deps.redraw();
    return было;
  }

  /** Снять всё: отложенные запуски переживают модель, если их не остановить. */
  dispose(): void {
    this.dead = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ── GraphHost ────────────────────────────────────────────────────────────

  readPointer(path: string, _type: string): GraphValue {
    if (path.startsWith('/animations/')) {
      if (path.endsWith('/maxTime')) {
        const clip = this.deps.clips[indexOf(path, 'animations')];
        return [clip ? clip.duration : 0];
      }
      return path; // сам адрес анимации и есть её имя для start/stop
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
      if (path.endsWith('/selectable')) return [1];
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
        this.deps.setClickable(indexOf(path, 'nodes'), truthy(value));
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
    // Конечное время приходит из графа: у наборa Khronos им нарезают один клип на куски.
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
    // Отложенный запуск обязан умереть вместе с моделью: иначе он оживёт над следующей
    // и подвинет чужие узлы. Та же беда, что была у запасных уровней детализации.
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
