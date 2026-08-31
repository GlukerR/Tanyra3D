// ui/viewer/interactivity-graph.ts — вычислитель графа поведения KHR_interactivity.
//
// ЗАКАЗ (Александр, 2026-08-28): «да, теперь видно интерактивные элементы. Но нажать я на
// них всё так же не могу». Выбор из трёх — делать все пять моделей набора Khronos.
//
// ЧТО ЭТО. Граф поведения — это узлы, связанные двумя видами связей: ПОТОК (что за чем
// выполняется) и ЗНАЧЕНИЯ (что откуда берётся). Нажали на деталь → сработал `event/onSelect`
// → пошёл поток → `pointer/set` покрасил материал. Здесь живёт разбор графа и его
// исполнение; сам мир — сцена, материалы, анимации — снаружи, за `GraphHost`.
//
// ПОЧЕМУ ХОЗЯИН СНАРУЖИ. Вычислитель не знает про three.js вовсе: он оперирует числами и
// адресами. Это не украшение — это то, чем он проверяем: граф можно прогнать в node без
// браузера, с подставным хозяином, и увидеть ровно ту последовательность записей, которую
// он делает.
//
// ЧЕСТНОЕ ПРАВИЛО ОТКАЗА (условие, на котором работа вообще бралась). Встретили узел,
// которого не знаем, — гасим интерактив ЦЕЛИКОМ и говорим об этом. Половинчатое
// проигрывание хуже отсутствия: на одной модели работает, на другой половина, и человек
// не понимает, сломана его модель или сломаны мы.
//
// РАЗМЕР ЗАДАЧИ БЫЛ ИЗМЕРЕН, А НЕ ПРИКИНУТ: 38 разных типов узлов на все пять моделей, из
// них 24 — арифметика в одну строку. Настоящий механизм — четырнадцать: поток, указатели,
// события, переменные, анимация, приведение типов.

/** Значение сокета. Числа — всегда массивом, даже скаляр: так их задаёт сам файл. */
export type GraphValue = number[] | string | null;

/** Что вычислитель просит у мира. Три группы: адреса, анимации, время. */
export interface GraphHost {
  /** Прочитать свойство по готовому адресу (`/nodes/5/rotation`). */
  readPointer(path: string, type: string): GraphValue;
  /** Записать свойство по готовому адресу. */
  writePointer(path: string, type: string, value: GraphValue): void;
  /** Запустить анимацию, названную адресом `/animations/3`. */
  startAnimation(path: string, speed: number, startTime: number, endTime: number): void;
  /** Остановить её же. */
  stopAnimation(path: string): void;
  /** Отложенный запуск. Секунды, как в файле. */
  delay(seconds: number, run: () => void): void;
  /** Строка из `debug/log` — в журнал, не человеку на экран. */
  log(message: string): void;
}

/** Узел, которого мы не знаем. Ловится снаружи и гасит интерактив целиком. */
export class UnknownOp extends Error {
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

/** Поэлементно, если оба вектора; иначе скаляром — так ведут себя math-узлы. */
function pair(a: GraphValue, b: GraphValue, f: (x: number, y: number) => number): number[] {
  const av = vec(a);
  const bv = vec(b);
  const n = Math.max(av.length, bv.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(f(av[i] ?? av[0] ?? 0, bv[i] ?? bv[0] ?? 0));
  return out;
}

const map1 = (a: GraphValue, f: (x: number) => number): number[] => vec(a).map(f);

/** Умножение кватернионов — единственная «неарифметическая» математика в наборе. */
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
  /**
   * Память вычисления на ОДИН шаг потока — и ни мгновением дольше.
   *
   * ПОЧЕМУ ИМЕННО ТАК, а не «на одну активацию», как было сначала. Считающие узлы тянутся
   * по цепочке и часто переиспользуются: без памяти ромб в графе считался бы дважды, вчетверо,
   * дальше по возрастающей. Но переменная за время одной активации МЕНЯЕТСЯ, и значение,
   * посчитанное до её изменения, после него — враньё.
   *
   * Так и сломался калькулятор. Нажатие на «÷» пишет в переменную floor(x/2), а следом
   * общая ветка показа читает ту же переменную, чтобы выставить цифры. Память на всю
   * активацию отдавала ей СТАРОЕ значение, оно тут же записывалось обратно поверх нового —
   * и деление, умножение, плюс и минус не делали ничего. Работали только кнопки цифр: они
   * пишут в переменную готовое число, ничего перед этим не читая. Александр, 2026-08-28:
   * «многие кнопки не работают, только цифры меняются на калькуляторе и всё».
   *
   * Шаг потока — естественная граница: узел берёт свои входы, они между собой согласованы,
   * и на этом память кончается.
   */
  private memo = new Map<string, GraphValue>();
  /** Стражи от зацикливания: граф с петлёй не должен вешать вкладку. */
  private steps = 0;

  constructor(graph: RawGraph, host: GraphHost) {
    this.graph = graph;
    this.host = host;
    for (const v of graph.variables || []) {
      if (typeof v.id !== 'string') continue;
      const raw = v.value as unknown[] | undefined;
      // Ссылка (`ref`) записана строкой-адресом: `["/nodes/10"]`. Разворачиваем её так же,
      // как это делает `input()` для значения, написанного прямо в сокете, — иначе одна и
      // та же ссылка приходила бы к адресату в двух разных видах.
      if (Array.isArray(raw) && typeof raw[0] === 'string') this.vars.set(v.id, raw[0]);
      else this.vars.set(v.id, (raw as number[]) ?? [0]);
    }
  }

  /** Все типы узлов графа — чтобы отказаться ДО первого нажатия, а не посреди него. */
  unknownOps(): string[] {
    const out = new Set<string>();
    for (const node of this.graph.nodes || []) {
      const op = this.opOf(node);
      if (!KNOWN.has(op)) out.add(op || '(без имени)');
    }
    return [...out].sort();
  }

  /** Узлы `event/onSelect`, ждущие нажатия на этот узел сцены. */
  selectorsFor(nodeIndex: number): number[] {
    const out: number[] = [];
    (this.graph.nodes || []).forEach((node, i) => {
      if (this.opOf(node) !== 'event/onSelect') return;
      const at = node.configuration?.['nodeIndex']?.value?.[0];
      if (at === nodeIndex) out.push(i);
    });
    return out;
  }

  /** Запустить то, что начинается само (`event/onStart`). */
  start(): void {
    (this.graph.nodes || []).forEach((node, i) => {
      if (this.opOf(node) === 'event/onStart') this.fire(i);
    });
  }

  /** Человек нажал на узел сцены с этим номером. */
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

  // ── Поток ────────────────────────────────────────────────────────────────

  /** Перейти по потоковому сокету и выполнить то, что на другом конце. */
  private runFlow(nodeIndex: number, socket: string): void {
    const node = this.graph.nodes?.[nodeIndex];
    const next = node?.flows?.[socket];
    if (!next || typeof next.node !== 'number') return;
    this.exec(next.node);
  }

  private exec(nodeIndex: number): void {
    // Потолок шагов — защита от петли в чужом файле. Число с запасом: у самой большой
    // модели набора 595 узлов графа, и один поток не обходит их все.
    if (++this.steps > 10000) return;

    const node = this.graph.nodes?.[nodeIndex];
    if (!node) return;
    const op = this.opOf(node);
    // Новый шаг потока — новое вычисление. Предыдущий шаг мог изменить переменную или
    // сцену, и всё посчитанное до него устарело.
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
        // Сокет со значением назван НОМЕРОМ переменной, а не нулём. У калькулятора
        // переменная одна и номер её ноль — оттого первая редакция и работала на нём, и
        // молчала на `MagicBall`, где переменных тридцать две: запись в первую попадала,
        // все остальные читали пустой сокет и клали в переменную ничто. Шар из-за этого
        // не показывал предсказание вовсе.
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
        // Порядок — по ИМЕНАМ сокетов (`sequ000`, `sequ001`, …), а не по порядку ключей
        // в объекте: в JSON порядок ключей формально не гарантирован, а смысл здесь
        // именно в очерёдности.
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
        // Событие в потоке — просто идём дальше; всё прочее нам неизвестно, и молчать
        // об этом нельзя.
        if (op === 'event/onSelect' || op === 'event/onStart') { this.runFlow(nodeIndex, 'out'); return; }
        throw new UnknownOp(op);
    }
  }

  // ── Значения ─────────────────────────────────────────────────────────────

  /** Значение входного сокета: либо записано в файле, либо считается соседним узлом. */
  private input(nodeIndex: number, socket: string): GraphValue {
    const slot = this.graph.nodes?.[nodeIndex]?.values?.[socket];
    if (!slot) return null;
    if (typeof slot.node === 'number') return this.output(slot.node, slot.socket ?? 'value');
    const raw = slot.value;
    if (!Array.isArray(raw)) return null;
    if (typeof raw[0] === 'string') return raw[0];
    return raw as number[];
  }

  /** Значение ВЫХОДНОГО сокета узла: тут и живёт вся арифметика. */
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
        // Выходные сокеты у извлечения numbered: `0`, `1`, `2`.
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
        // Выходы события: узел, на который нажали, и куда именно. Точку попадания мы не
        // считаем — она нужна только графам, которые её читают, а в наборе таких нет.
        return socket === 'selectedNode' ? this.selectedNode : null;
      default:
        throw new UnknownOp(op);
    }
  }

  /** Узел, на который нажали, — виден узлам события как выходное значение. */
  private selectedNode: GraphValue = null;

  setSelected(path: string | null): void {
    this.selectedNode = path;
  }

  /**
   * Имя переменной по номеру из настройки узла.
   *
   * Ключ настройки у чтения и записи РАЗНЫЙ (`variable` против `variables`) — это не
   * опечатка, так в файлах набора.
   */
  private variableId(node: RawNode, key: string): string | null {
    const at = node.configuration?.[key]?.value?.[0];
    if (typeof at !== 'number') return null;
    return this.graph.variables?.[at]?.id ?? null;
  }

  /**
   * Собрать готовый адрес из шаблона: `/materials/{materialRef}/…` → `/materials/3/…`.
   *
   * Ссылка приходит отдельным входным сокетом и сама записана адресом (`/materials/3`) —
   * поэтому берём из неё последнее число. Так это и устроено в файлах: тип `ref`.
   */
  private resolvePointer(nodeIndex: number): string | null {
    const raw = this.graph.nodes?.[nodeIndex]?.configuration?.['pointer']?.value?.[0];
    if (typeof raw !== 'string') return null;
    let out = raw;
    for (const match of raw.matchAll(/\{([^}]+)\}/g)) {
      const socket = match[1] ?? '';
      const ref = this.input(nodeIndex, socket);
      const at = typeof ref === 'string' ? /(\d+)\s*$/.exec(ref)?.[1] : String(num(ref));
      if (at === undefined || at === null) return null;
      out = out.replace(match[0], at);
    }
    return out;
  }
}

/** Всё, что вычислитель умеет. Ровно по этому списку и решается, браться ли за граф. */
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
