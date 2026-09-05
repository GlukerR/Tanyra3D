// stub-viewer.ts — ВТОРАЯ реализация контракта просмотра. Не движок и никогда им не станет.
//
// ЗАЧЕМ ОНА ЕСТЬ. `contract.ts` заведён для того, чтобы шов между обвязкой и движком
// проверял компилятор, а не живая модель. Но проверять ему было нечего: реализация в
// дереве одна, а один класс согласуется с интерфейсом, вырезанным из него самого,
// при любом составе интерфейса. Дыры в шве обнаруживались бы ровно тогда, когда в него
// поехал бы Babylon.js, — то есть в самый неудобный момент.
//
// Заглушка снимает эту слепоту. Она объявляет `implements ViewerLike`, не знает ни одного
// имени из три.js и не рисует моделей: её единственная работа — быть НЕ три.js и всё равно
// собираться. Что она умеет — то умеет любой движок; чего не может выразить она, то
// контракт требует напрасно.
//
// ЧТО ОНА НАШЛА В ПЕРВЫЙ ЖЕ ДЕНЬ (2026-09-05). Семь вызовов, которые обвязка делает у
// движка мимо контракта, приведением типа в месте вызова:
//
//   setOnBusy · densityRange · setDensityScale · textureRefs · setDiffReference ·
//   useDiffStore · diffScale
//
// То есть три возможности, добавленные за две недели, — плашка о долгой работе, общая
// шкала плотности и четвёртый режим показа, — прошли мимо шва целиком. Движок, написанный
// строго по контракту, собрался бы без замечаний и молча остался бы без всех трёх. Теперь
// подписи стоят в контракте, а приведения из обвязки убраны; сторож, чтобы они не
// вернулись, — `tests/viewer-contract.test.mjs`.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ПРОЕКТ СБОРКИ (`tsconfig.contract.json`, `noEmit`). В `ui/` файлу не
// место: он поехал бы в приложение мёртвым грузом, а `VIEWERS` в `index.ts` рядом —
// соблазн подключить. В `tests/` его никто не подключит, но и компилятор бы его не увидел:
// `tsconfig.ui.json` смотрит только в `ui/`. Третий проект решает оба: файл лежит у тестов,
// проверяется на каждом `npm run typecheck` (и в CI), а на диск не пишется ничего.
//
// ЧЕГО ОНА НЕ ДЕЛАЕТ. Не проверяет ПОВЕДЕНИЕ — только форму. Что обвязка зовёт методы в
// верном порядке и в верный момент, доказывают браузерные проверки на настоящем движке.

import type {
  AnimationInfo,
  CameraChangeSource,
  CameraListInfo,
  CameraState,
  DiffEntry,
  DiffReference,
  DisplayMode,
  LightInfo,
  LoadOptions,
  LodInfo,
  SnapshotOptions,
  SnapshotResult,
  VariantInfo,
  ViewerDetection,
  ViewerLike,
  ViewerStats,
} from '../../ui/viewer/contract.js';

/**
 * Источник события «камера двигалась» без единой чужой зависимости. Контракт просит у
 * движка ровно две операции — и вот они целиком, в девять строк: требование посильное.
 */
class Слушатели implements CameraChangeSource {
  private readonly кто = new Set<() => void>();

  addEventListener(_type: 'change', listener: () => void) {
    this.кто.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void) {
    this.кто.delete(listener);
  }

  /** Позвать всех — так настоящий движок сообщает обвязке о сдвиге камеры. */
  сказать() {
    for (const f of this.кто) f();
  }
}

/**
 * Движок, который ничего не показывает и честно об этом говорит.
 *
 * Ответы подобраны так, чтобы обвязка вела себя разумно: уровней нет, вариантов нет,
 * своего света нет, текстур нет — то есть каждая возможность, которой у движка не
 * случилось, отвечает нулём и `false`, а не выдумывает. Ровно этого мы будем ждать и от
 * настоящей второй реализации: «не умею» — законный ответ, «сделал вид» — нет.
 */
export class StubViewer implements ViewerLike {
  readonly controls = new Слушатели();

  onInteractivePick: ((part: { name: string; responded: boolean }) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private камера: CameraState = {
    position: { x: 0, y: 0, z: 1 },
    target: { x: 0, y: 0, z: 0 },
    near: 0.01,
    far: 100,
    minDistance: 0.1,
    maxDistance: 50,
  };
  private режим: DisplayMode = 'file';
  private загружено = false;
  private время = 0;
  private экспозиция = 1;
  private свет: LightInfo['mode'] = 'studio';
  private память: Map<string, DiffEntry> | null = null;
  private занят: ((busy: boolean) => void) | null = null;
  private поискФайла: ((url: string) => string | null) | null = null;
  private пачка: string[] | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async load(_url: string, options?: LoadOptions) {
    this.загружено = true;
    if (options?.camera) this.applyCameraState(options.camera);
    return null;
  }

  getStats(): ViewerStats | null {
    if (!this.загружено) return null;
    return { triangles: 0, vertices: 0, drawCalls: 0, materials: 0, textures: 0 };
  }

  getDetection(): ViewerDetection | null {
    if (!this.загружено) return null;
    return {
      draco: false,
      meshopt: false,
      ktx2: false,
      instance: false,
      opportunity: { sharedMeshes: 0, sharedNodes: 0 },
    };
  }

  /**
   * Один кадр. Заливка, а не картинка: у заглушки нет ни сцены, ни модели. Полотно всё же
   * трогаем — так видно, что обвязка действительно гонит цикл, и так проверка на живой
   * странице отличает «работает» от «висит».
   */
  renderFrame() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = this.режим === 'wire' ? '#202028' : '#181820';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  frame() {
    this.камера = { ...this.камера, position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 } };
    this.controls.сказать();
  }

  getCameraState(): CameraState {
    return {
      position: { ...this.камера.position },
      target: { ...this.камера.target },
      near: this.камера.near,
      far: this.камера.far,
      minDistance: this.камера.minDistance,
      maxDistance: this.камера.maxDistance,
    };
  }

  applyCameraState(state: CameraState | null) {
    if (!state) return;
    this.камера = {
      position: { ...state.position },
      target: { ...state.target },
      near: state.near,
      far: state.far,
      minDistance: state.minDistance,
      maxDistance: state.maxDistance,
    };
  }

  setAnimationTime(seconds: number) {
    this.время = seconds;
  }

  playClip(_index: number) {
    /* анимаций нет — переключать нечего */
  }

  getAnimationInfo(): AnimationInfo {
    return { count: 0, names: [], index: 0, duration: this.время * 0 };
  }

  getLodInfo(): LodInfo {
    return { count: 0, source: null, names: [], triangles: [], current: null };
  }

  setLod(_index: number | 'all' | null) {
    return false;
  }

  getCameraInfo(): CameraListInfo {
    return { count: 0, names: [], current: null };
  }

  setCamera(_index: number | null) {
    return false;
  }

  getInteractivityInfo() {
    return { count: 0, names: [] as string[], shown: false };
  }

  setInteractivityMarks(_on: boolean) {
    return false;
  }

  getBehaviourInfo() {
    return { playable: false, refusal: [] as string[] };
  }

  getLightInfo(): LightInfo {
    return { count: 0, mode: this.свет };
  }

  setLightMode(mode: LightInfo['mode']) {
    // Своего света у модели нет, поэтому режим «из файла» отклоняется — как и просит
    // контракт: `false` значит «показывать нечем», а не «не хочу».
    if (mode === 'file') return false;
    this.свет = mode;
    return true;
  }

  getVariantInfo(): VariantInfo {
    return { count: 0, names: [], current: null };
  }

  async setVariant(_name: string | null) {
    return false;
  }

  setExposure(value: number) {
    this.экспозиция = value;
  }

  setDisplayMaterial(mode: DisplayMode) {
    this.режим = mode;
    return true;
  }

  getDisplayMaterial(): DisplayMode {
    return this.режим;
  }

  hasTextures() {
    return false;
  }

  /**
   * Снимок кадра. Метод в контракте необязательный, и заглушке ничто не мешало бы его не
   * иметь — но тогда его подпись осталась бы непроверенной на движке без три.js, а
   * непроверенная подпись и есть то, ради чего этот файл написан. Поэтому реализованы ВСЕ
   * члены контракта, включая необязательные.
   *
   * Что обвязка умеет обходиться без них — доказывает не заглушка, а `canSnapshot()` и
   * браузерные проверки вокруг него.
   */
  async snapshot(options?: SnapshotOptions): Promise<SnapshotResult | null> {
    const w = options?.width ?? this.canvas.width;
    const h = options?.height ?? this.canvas.height;
    this.renderFrame();
    const blob = await new Promise<Blob | null>((готово) => this.canvas.toBlob(готово, 'image/png'));
    return blob ? { blob, width: w, height: h } : null;
  }

  setAssetResolver(resolve: ((url: string) => string | null) | null) {
    this.поискФайла = resolve;
  }

  setPackFiles(paths: string[] | null) {
    this.пачка = paths ? [...paths] : null;
  }

  // ── Что нужно обоим окнам сразу ─────────────────────────────────────────────────────
  //
  // Ради этой половины заглушка и написана: все семь подписей выражаются без единого имени
  // из три.js. Значит контракт не диктует чужой реализации форму её ресурсов — а это и был
  // вопрос.

  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this.занят = typeof fn === 'function' ? fn : null;
  }

  densityRange(): [number, number] | null {
    return null;
  }

  setDensityScale(_range: [number, number] | null) {
    /* красить нечего */
  }

  textureRefs(): DiffReference[] {
    return [];
  }

  setDiffReference(_refs: DiffReference[] | null) {
    /* сравнивать нечего */
  }

  useDiffStore(store: Map<string, DiffEntry>) {
    this.память = store;
  }

  diffScale(): number | null {
    return null;
  }

  dispose() {
    this.загружено = false;
    this.память = null;
    this.поискФайла = null;
    this.пачка = null;
    this.занят?.(false);
    this.занят = null;
    // Экспозиция и время читаются только отсюда: у заглушки нет картинки, на которую они
    // влияли бы. Ссылки нужны, чтобы компилятор не счёл поля забытыми.
    void this.экспозиция;
    void this.время;
  }
}
