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
  loadOriginal(file: File): Promise<unknown>;
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
   * Варианты материала: запасные цвета и отделки, между которыми модель умеет
   * переключаться. `count === 0` — их в модели нет, и панели быть не должно.
   * Имена приходят ИЗ ФАЙЛА и переводу не подлежат (Правило 8: это данные).
   */
  getVariants(): { count: number; names: string[]; current: string | null; selected: string | null };
  /** Переключить вариант в ОБОИХ вьюпортах; null — основной вид из файла. */
  selectVariant(name: string | null): Promise<void>;
  setExposure(v: number): void;
  getExposure(): number;
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
