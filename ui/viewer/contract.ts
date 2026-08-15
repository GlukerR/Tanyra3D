// contract.ts — что обязан уметь ЛЮБОЙ движок просмотра.
//
// Зачем отдельным файлом. До этого контракт существовал только комментарием в index.ts,
// а обвязка была типизирована КОНКРЕТНЫМ классом три.js (`Record<string, () => Viewer>`).
// Пока реализация одна, разницы не видно; второй движок упирается в неё сразу:
//
// 1. `Viewer` несёт поля `renderer: THREE.WebGLRenderer`, `_draco: DRACOLoader`,
//    `scene: THREE.Scene`. Структурная совместимость требует их и от чужой реализации —
//    то есть движок на Babylon.js обязан был бы завести у себя рендерер три.js.
// 2. `CameraState` носил `THREE.Vector3`. Даже ДАННЫЕ, которыми обмениваются два
//    вьюпорта, имели форму три.js: чужой реализации пришлось бы тянуть три.js ради
//    трёх чисел.
// 3. Комментарий разошёлся с делом: обвязка зовёт `setExposure()`, а в списке контракта
//    его не было. Движок, написанный строго по комментарию, молча остался бы без
//    экспозиции — и это выяснилось бы уже на экране.
//
// Проверка «шов настоящий?» из `ROADMAP.md` §5g теперь выполняется компилятором:
// реализация объявляет `implements ViewerLike`, и расхождение — ошибка сборки, а не
// находка на живой модели.
//
// Здесь НЕТ ни одного импорта из три.js — это и есть смысл файла.

/** Три числа. Не `THREE.Vector3`: обмен между вьюпортами — это данные, а не объекты движка. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Состояние камеры, которым обмениваются два вьюпорта.
 *
 * Поля — не только позиция: near/far и пределы приближения входят в снимок потому, что
 * иначе окна расходятся на краях диапазона и разница настроек показа выглядит как
 * последствие оптимизации. Подробности — у `getCameraState()` в реализации.
 */
export interface CameraState {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
}

/** Что просмотрщику нужно знать о загрузке: ход дела и ракурс, который надо сохранить. */
export interface LoadOptions {
  onProgress?: ((event: ProgressEvent) => void) | undefined;
  camera?: CameraState | null;
}

/** Метрики модели для HUD. Считает их сам движок — по тому, что реально попало в сцену. */
export interface ViewerStats {
  triangles: number;
  vertices: number;
  drawCalls: number;
  materials: number;
  textures: number;
}

/**
 * Что напрашивается по содержимому модели, а не что в ней уже есть. Смешивать нельзя:
 * иначе значок «В модели» перестанет что-либо означать.
 */
export interface ViewerOpportunity {
  sharedMeshes: number;
  sharedNodes: number;
}

/** Что уже применено в ИСХОДНОЙ модели — по её собственному объявлению расширений. */
export interface ViewerDetection {
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
  instance: boolean;
  opportunity: ViewerOpportunity;
}

export interface AnimationInfo {
  count: number;
  names: string[];
  index: number;
  duration: number;
}

/**
 * Уровни детализации модели: одна и та же вещь, сделанная автором в нескольких степенях
 * подробности. Переключение между ними — состояние ПОКАЗА, а не правка файла.
 *
 * `source` обязан доходить до интерфейса: 'extension' — автор связал уровни расширением,
 * это факт; 'names' — мы узнали их по именам соседних узлов, это ДОГАДКА, и выдавать её
 * за факт нечестно.
 */
export interface LodInfo {
  count: number;
  source: 'extension' | 'names' | null;
  /** Имена узлов из файла. Переводу не подлежат — данные, а не интерфейс (Правило 8). */
  names: string[];
  /** Треугольников в каждом уровне: по ним человек и отличает уровни друг от друга. */
  triangles: number[];
  /** Показанный уровень: номер, `'all'` — все сразу, `null` — как в файле. */
  current: number | 'all' | null;
}

/**
 * Варианты материала — запасные цвета и отделки, между которыми модель умеет
 * переключаться (три окраски машины, четыре ремешка часов).
 *
 * Имена приходят ИЗ ФАЙЛА, их писал художник в своём редакторе, и переводу они не
 * подлежат — это данные, а не интерфейс (Правило 8). `current: null` означает вид,
 * записанный в файле как основной; подменять его первым именем из списка нельзя.
 */
export interface VariantInfo {
  count: number;
  names: string[];
  current: string | null;
}

/**
 * Источник события «камера двигалась». У три.js это OrbitControls, у другого движка —
 * что угодно своё; обвязке нужны ровно две операции, и требовать больше незачем.
 */
export interface CameraChangeSource {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/**
 * Контракт движка просмотра.
 *
 * Время анимации задаётся СНАРУЖИ и абсолютным значением, а не приращением. Это
 * обязательное требование к любой реализации: два вьюпорта показывают одну модель до и
 * после, и разъехавшаяся на полкадра поза делает сравнение бессмысленным.
 *
 * Движок отвечает только за СВОИ ресурсы. Пустое состояние слота (очистка полотна при
 * сбросе) — забота обвязки, одинаковая для всех движков (`ViewportSlot.reset()`), чтобы
 * смена движка не меняла поведение действий вокруг него.
 */
export interface ViewerLike {
  /** Загрузить модель и вернуть управление, когда она готова к показу. */
  load(url: string, options?: LoadOptions): Promise<unknown>;
  getStats(): ViewerStats | null;
  getDetection(): ViewerDetection | null;
  /** Отрисовать ОДИН кадр. Цикл гонит обвязка — она же сводит два вьюпорта в один кадр. */
  renderFrame(): void;
  /** Навести камеру на модель. */
  frame(): void;
  getCameraState(): CameraState;
  applyCameraState(state: CameraState | null): void;
  controls: CameraChangeSource;
  setAnimationTime(seconds: number): void;
  playClip(index: number): void;
  getAnimationInfo(): AnimationInfo;
  /** Какие уровни детализации есть у модели; count === 0 — их нет. */
  getLodInfo(): LodInfo;
  /** Показать уровень (0 — самый подробный), 'all' — все, null — как в файле. */
  setLod(index: number | 'all' | null): boolean;
  /** Какие варианты материала есть у модели; count === 0 — их нет вовсе. */
  getVariantInfo(): VariantInfo;
  /** Переключить вариант; null — вернуть основной вид из файла. false = не вышло. */
  setVariant(name: string | null): Promise<boolean>;
  /** Общая экспозиция обоих окон. В прежнем списке контракта её не было — см. шапку. */
  setExposure(value: number): void;
  dispose(): void;
}
