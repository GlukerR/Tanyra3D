// ui/dto.d.ts — что интерфейс получает от сервера.
//
// Тот самый шов, ради которого перевод интерфейса и затевался. До 2026-08-11 он был
// типизирован С ОДНОЙ СТОРОНЫ: сервер знает форму своих ответов, интерфейс выводил её
// заново из того, как читает поля. Сервер переименовывает поле — интерфейс молча рисует
// пустоту, и заметит это только человек, глядя на экран.
//
// Описания НАМЕРЕННО неполные там, где данные приходят из ФАЙЛОВ, а не из кода:
// профиль площадки и описание движка — это JSON, состав которого задаёт автор профиля
// (docs/EXTENDING.md §4). Перечислить их поля здесь значило бы запретить сторонним
// профилям иметь свои. Поэтому у таких форм есть индексная сигнатура, а поимённо
// описано лишь то, что интерфейс действительно читает.
//
// Источник правды — core/types.mts (RunResult) и assistant.mts (планы, бюджеты).
// Дублирование сознательное: у браузерного слоя своя сборка и своя среда, импортировать
// туда серверные типы нельзя, не заведя третий проект компиляции. Расхождение ловится
// не типом, а тестами контракта API.

/** Запись отчёта: готовый текст плюс, по возможности, рецепт для смены языка. */
interface ReportEntryDto {
  ruleId?: string;
  text: string;
  reason?: string;
  /** Почему пропущено: disabled | nothing | unsafe | policy | cost | exclusive. */
  kind?: string;
  /** Та галочка, к которой относится запись, — по ней интерфейс ставит значок. */
  feature?: string | null;
  fixSafety?: string;
  reversible?: boolean;
  dataLoss?: string;
  level?: string;
  [key: string]: any;
}

/** Ответ /api/optimize — контракт §4b, собранный движком. */
interface RunResultDto {
  status: 'ok' | 'skip' | 'fail';
  file: { src: string; dst: string | null; written: boolean; reportPath: string | null };
  findings: ReportEntryDto[];
  skipped: ReportEntryDto[];
  applied: ReportEntryDto[];
  validation: ReportEntryDto[];
  metrics: { before: Record<string, any> | null; after: Record<string, any> | null };
  error?: string;
  [key: string]: any;
}

/** Ответ /api/explain — объяснение результата и сверка с бюджетом площадки. */
interface ExplainDto {
  summary?: string;
  highlights?: string[];
  warnings?: string[];
  /** Сверка с порогами: level none | warn | over. Красное горит только на 'over'. */
  budgetChecks?: Array<{
    id: string;
    name: string;
    actualText: string;
    level: string;
    advice?: string;
    [key: string]: any;
  }>;
  [key: string]: any;
}

/** Ответ /api/inspect и /api/inspect-result — метаданные и отчёт валидатора. */
interface InspectDto {
  format?: string | null;
  /**
   * Формат, из которого модель ПРИШЛА (stl, ply). Есть только у разбора чужого формата —
   * у обычного glTF его нет вовсе, и это работающий признак: по нему видно, что
   * проверять по стандарту glTF здесь нечего.
   */
  sourceFormat?: string;
  asset?: { version?: string; generator?: string };
  extensions?: string[];
  metadata?: Record<string, any> | null;
  metrics?: Record<string, any> | null;
  validation?: Array<Record<string, any>>;
  [key: string]: any;
}

/** Площадка из /api/platforms. Состав — из profiles/*.json. */
interface PlatformDto {
  id: string;
  title: string;
  description?: string;
  [key: string]: any;
}

/** Движок из /api/engines. Состав — из engines/*.json. */
interface EngineDto {
  id: string;
  title: string;
  description?: string;
  viewer?: string;
  [key: string]: any;
}

/**
 * Одно поле порога в форме своей площадки (/api/profiles/template). Состав полей —
 * это метрики бюджета: интерфейс их не перечисляет, чтобы список не разошёлся с тем,
 * что сверяется на самом деле (решение 2026-08-12).
 */
interface BudgetFieldDto {
  id: string;
  name: string;
  /** Подпись единицы у поля ввода. Пустая — у счётных метрик, там единицы нет. */
  unit: string;
}

/** Одна опция панели возможностей (/api/extensions). Слова — из messages/. */
interface ExtensionDto {
  id: string;
  title?: string;
  description?: string;
  impact?: string;
  opts?: Record<string, any>;
  [key: string]: any;
}

/** Цифры о модели для HUD: считает вьюер слева, движок справа. */
interface Stats {
  [key: string]: any;
}

/** Что найдено в исходнике (draco/meshopt/ktx2) — для авто-флажков [Source]. */
interface Detection {
  [key: string]: any;
}

/**
 * Беда С САМОЙ МОДЕЛЬЮ, а не с нашей работой: файл не читается либо в нём ошибки по
 * стандарту glTF. Отдельное состояние, потому что показывать её надо там, где человек
 * выбирает модель, а не там, где он читает отчёт о сборке.
 */
interface ModelIssue {
  kind: 'unreadable' | 'incomplete' | 'validation';
  count?: number;
  detail?: string;
  [key: string]: any;
}

/**
 * Выбор человека в панели возможностей. Переживает смену площадки и смену языка:
 * панель перерисовывается, а галочки восстанавливаются из этого снимка.
 */
interface UiSelection {
  geometryChoice: string;
  /** Выбранный потолок размера текстур: 'none' | 'resize-4096' | … (2026-08-12). */
  textureSizeChoice: string;
  ktx2Mode: string;
  checked: string[];
  /** Просит ли человек оставить развёртку, которой не пользуется ни одна картинка. */
  keepUnusedUv?: boolean;
  [key: string]: any;
}

/**
 * Файл ровно так, как его бросили: сам файл и его путь внутри броска
 * (`Chair/textures/wood.png`). Путь нужен, чтобы связать ссылку внутри `.gltf` с
 * брошенным файлом; по одному имени это сделать нельзя — картинок с именем
 * `basecolor.png` в модели бывает много.
 */
interface DroppedFile {
  file: File;
  path: string;
}

/** Сосед модели: адрес ОТ САМОЙ МОДЕЛИ, как написано внутри `.gltf`. */
interface PackFile {
  path: string;
  file: File;
}

/**
 * Строка списка моделей слева. Порядок массива = порядок загрузки.
 * `state` — снимок состояния приложения для ЭТОЙ модели (PER_MODEL_STATE): при
 * переключении между моделями настройки и результат не теряются.
 */
interface ModelEntry {
  id: string;
  file: File;
  /**
   * Соседние файлы `.gltf`: `.bin` с геометрией и картинки текстур. У `.glb` пуста
   * всегда — он самодостаточен, и прикладывать к нему брошенное рядом значило бы
   * править модель за человека (Правило 11).
   */
  pack: PackFile[];
  /** Номер папки пачки на сервере; null — соседей ещё не возили либо их нет. */
  packSourceId: string | null;
  /** Сверяли ли пачку со ссылками внутри `.gltf`. Одна модель — одно предупреждение. */
  packChecked: boolean;
  /** Скольких файлов пачке не хватило; 0 — все на месте. */
  packMissing: number;
  /** Сказали ли уже, что модель тяжелее расчётной. Одна модель — одна строка. */
  heavyWarned: boolean;
  state: Record<string, any>;
  /**
   * Отмечена ли модель для пакетной сборки. Отдельно от `activeModelId`: показывается
   * одна модель, а собирается столько, сколько отмечено. Слово Александра 2026-08-18:
   * «из 50 загруженных для гугл стор хочу только 20. я должен иметь возможность их все
   * 20 и выбрать».
   */
  picked: boolean;
  [key: string]: any;
}
