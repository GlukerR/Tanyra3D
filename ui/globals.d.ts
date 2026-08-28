// ui/globals.d.ts — глобальные имена браузерного слоя.
//
// Приложение работает БЕЗ сборщика: каталоги переводов подключаются обычными тегами
// <script> и кладут себя в `window`, туда же кладёт себя i18n. Значит связь между
// файлами здесь — не импорт, а глобальная переменная, и описать её можно только так.
//
// Заведено 2026-08-11 вместе с переводом интерфейса на TypeScript.

/** Значение каталога: строка с подстановками {name} либо функция от них. */
type UiMessage = string | ((params: Record<string, unknown>) => string);

/** Каталог одного языка интерфейса (ui/locales/*.js, translations/*.js). */
type UiCatalog = Record<string, UiMessage>;

/** Подстановки сообщения. */
type UiParams = Record<string, unknown>;

/** Публичное лицо ui/i18n: единственный способ получить текст для человека (Правило 8). */
interface I18nApi {
  t(key: string, params?: UiParams): string;
  /** Выбор формы числа по правилам ЯЗЫКА, а не по строке: 1/2/5 замечаний. */
  plural(n: number, forms: string[]): string;
  /** Перевод статики по атрибутам разметки. Без аргумента — весь документ. */
  apply(root?: ParentNode | null): void;
  setLang(next: string): void;
  /** Подпись, которую ставит КОД, помечается ключом — иначе apply() её откатит. */
  setText(el: Element | null, key: string, values?: UiParams): void;
  setTitle(el: Element | null, key: string, values?: UiParams): void;
  setAria(el: Element | null, key: string, values?: UiParams): void;
  /** Текст не из каталога (причина от движка, имя файла): снимает ключ, чтобы смена языка его не откатила. */
  setRaw(el: Element | null, text: string): void;
  readonly lang: string;
  languages(): string[];
  onChange(fn: (lang: string) => void): void;
}

/**
 * Просмотрщик. ui/viewer/ — настоящий ES-модуль, а app.js — классический скрипт, и
 * связать их можно только через window (см. шапку ui/viewer/index.ts). Здесь описано
 * ровно то, что отдаётся наружу, — форма взята из `window.OptiViewer = {...}` там же.
 */
interface OptiViewerApi {
  /** Какие вьюпорты приложение умеет монтировать. */
  implementations(): string[];
  useViewer(id: string): void;
  currentViewer(): string;
  /**
   * Показать исходную модель. `pack` — соседние файлы (.bin, текстуры) для `.gltf`,
   * брошенного вместе с ними; `path` в каждом — адрес относительно самой модели.
   *
   * Тип расписан здесь, а не импортирован из ui/viewer/contract.ts, намеренно: этот файл
   * ГЛОБАЛЬНЫЙ, и первый же `import` превратил бы его в модуль — тогда `window.OptiViewer`
   * перестал бы быть виден в app.ts вовсе.
   */
  loadOriginal(file: File, pack?: Array<{ path: string; file: File | Blob }> | null): Promise<unknown>;
  /**
   * Привести адрес соседнего файла к общему виду. Нужен приложению, чтобы сверять
   * ссылки внутри `.gltf` с брошенными файлами ТЕМ ЖЕ правилом, каким просмотрщик
   * подменяет адреса при показе.
   */
  assetKey(path: string): string;
  loadOptimized(url: string): Promise<unknown>;
  resetView(): void;
  setLinked(on: boolean): void;
  reset(): void;
  cameraStates(): unknown;
  /** Сведения об анимации. Форма — из DualViewport.getAnimation() в ui/viewer/index.ts. */
  getAnimation(): {
    count: number;
    names: string[];
    index: number;
    duration: number;
    playing: boolean;
    time: number;
    [key: string]: any;
  };
  setAnimationPlaying(on: boolean): void;
  seekAnimation(sec: number): void;
  selectAnimationClip(i: number): void;
  /**
   * Уровни детализации. `source`: 'extension' — автор связал их расширением (факт);
   * 'names' и 'measured' — узнали по соседним узлам (догадка, с подписью и без).
   * Интерфейс обязан отличать факт от догадки.
   */
  getLods(): {
    count: number;
    source: 'extension' | 'names' | 'measured' | null;
    names: string[];
    triangles: number[];
    current: number | 'all' | null;
    selected: number | 'all' | null;
  };
  /** Показать уровень в обоих вьюпортах; null — как в файле. */
  selectLod(index: number | 'all' | null): void;
  /**
   * Варианты материала: запасные цвета и отделки, между которыми модель умеет
   * переключаться. `count === 0` — их в модели нет, и панели быть не должно.
   * Имена приходят ИЗ ФАЙЛА и переводу не подлежат (Правило 8: это данные).
   */
  getVariants(): { count: number; names: string[]; current: string | null; selected: string | null };
  /** Переключить вариант в ОБОИХ вьюпортах; null — основной вид из файла. */
  selectVariant(name: string | null): Promise<void>;
  /**
   * Свет модели. `count` — сколько источников принесла САМА модель; ноль означает, что
   * переключать нечего и значка быть не должно: «свет из файла» без источников — тьма.
   */
  getLight(): { count: number; mode: 'studio' | 'file' | 'none' };
  /**
   * Части, откликающиеся на нажатие НА САЙТЕ, и показана ли их обводка. Мы их только
   * ПОКАЗЫВАЕМ: граф поведения не проигрывается.
   */
  getInteractivity(): { count: number; names: string[]; shown: boolean; playable: boolean };
  /** Обвести нажимаемые части в обоих вьюпортах либо снять обводку. */
  toggleInteractivity(on?: boolean): boolean;
  /** Выбрать свет — в ОБОИХ вьюпортах: студийный, авторский или никакой. */
  selectLightMode(mode: 'studio' | 'file' | 'none'): void;
  /**
   * Камеры автора. `current: null` — смотрим своей орбитальной. Имена ИЗ ФАЙЛА,
   * пустое имя остаётся пустым: подпись безымянной придумывает интерфейс.
   */
  getCameras(): { count: number; names: string[]; current: number | null };
  /** Смотреть через камеру автора либо вернуться к своей — в ОБОИХ вьюпортах. */
  selectCamera(index: number | null): void;
  setExposure(v: number): void;
  getExposure(): number;
  /**
   * Материал показа: 'file' — материалы модели, 'clay' — наша глина для моделей без
   * текстур. Выбор ОДИН на оба окна: разъехавшийся показ превратил бы сравнение «до и
   * после» в сравнение способов рисовать. Файл при этом не меняется никогда.
   */
  setDisplayMaterial(mode: 'wire' | 'clay' | 'file'): void;
  getDisplayMaterial(): 'wire' | 'clay' | 'file';
  /**
   * Снимок ПРАВОГО окна как PNG — ровно того кадра, что человек видит.
   *
   * Размеры не обещание: движок обрежет их по потолку видеокарты и вернёт настоящие.
   * `background: null` — прозрачный фон. Типы расписаны здесь, а не импортированы из
   * `ui/viewer/contract.ts`, по той же причине, что и у `loadOriginal` выше.
   */
  snapshot(options?: { width?: number; height?: number; background?: string | null }):
    Promise<{ blob: Blob; width: number; height: number } | null>;
  /** Есть ли что снимать и умеет ли текущий движок снимать вообще. */
  canSnapshot(): boolean;
  /** Нагрузка на отрисовку либо null, пока окно замера не набралось. */
  getPerf(): { leftMs?: number; rightMs?: number; fps?: number } | null;
  setOnLoaded(fn: () => void): void;
}

interface Window {
  /** Каталоги, сложенные тегами <script> ДО app.js. */
  I18N_CATALOGS?: Record<string, UiCatalog>;
  I18n: I18nApi;
  OptiViewer: OptiViewerApi;
  /** Мост из модуля вьюпорта: он не видит window.OptiViewer в момент подписки. */
  onOptiViewerModelLoaded?: () => void;
}

/**
 * Подстановки динамической подписи хранятся НА САМОМ элементе: у текста и у подсказки
 * они разные (⊞ Metadata (12) при подсказке без чисел). Своё поле, а не data-атрибут,
 * потому что значения — объекты, а не строки.
 */
interface Element {
  __i18n?: Record<string, UiParams | undefined>;
}
