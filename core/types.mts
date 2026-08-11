// core/types.mts — формы данных движка. Первый модуль проекта на TypeScript.
//
// Раньше это был core/types.mjs: те же формы, записанные в JSDoc. Модуль выбран первым
// для перехода намеренно — в нём НЕТ исполняемого кода, только описания, поэтому
// поведение приложения не может измениться от такой правки физически. Компилятор кладёт
// рядом core/types.mjs (пустой модуль) и core/types.d.mts (собственно типы), так что
// ссылки вида `import('./types.mjs').Addon` из JSDoc в engine.mjs, registry.mjs и аддонах
// продолжают работать без единой правки.
//
// Контракт публичного API (RunResult, optimizeFile) — docs/ARCHITECTURE.md §4b;
// границы core/addon — там же.
//
// Про `unknown` вместо `any`. Документ модели и IO для движка непрозрачны: он их не
// читает, а передаёт правилам аддона. `any` сказал бы «тут можно всё», хотя верно
// обратное — трогать содержимое вправе только тот, кто знает формат. Аддон сузит эти
// типы у себя, когда сам переедет на TypeScript.

/** Модель в памяти. Для glTF — Document из @gltf-transform/core. */
export type AddonDocument = unknown;

/** Читатель/писатель формата. Для glTF — NodeIO с подключёнными декодерами. */
export type AddonIO = unknown;

/**
 * Числа, снятые с модели. Состав задаёт аддон (для glTF — fileBytes, gpuBytes,
 * triangles, materials, drawCalls и прочее), движок их только переносит в отчёт.
 * Точный тип появится вместе с переездом addons/gltf/metrics на TypeScript.
 */
export type Metrics = Record<string, unknown>;

/** Доказуемость безопасности правки — от «доказано» до «теряем данные». */
export type FixSafety = 'provable' | 'numeric' | 'perceptual' | 'lossy';

// --- язык отдельно от кода (Правило 8) ---------------------------------------------

/** Подстановки сообщения. Значение может быть и вложенным сообщением — см. MessageRef. */
export type MessageData = Record<string, unknown>;

/**
 * Рецепт строки: ключ каталога плюс подстановки. Именно он позволяет пересобрать готовый
 * отчёт на другом языке, не запуская обработку заново (localizeResult в core/i18n.mjs).
 */
export interface MessageRef {
  messageId: string;
  data?: MessageData;
}

/** Значение каталога: готовая строка с плейсхолдерами {ключ} либо функция от подстановок. */
export type MessageTemplate = string | ((data: MessageData) => string);

/** Каталог одного языка: ключ сообщения → шаблон. Живёт в messages/, не в логике. */
export type MessageCatalog = Record<string, MessageTemplate>;

/** Строка отчёта: либо готовый текст, либо рецепт, который переживёт смену языка. */
export type Message = string | MessageRef;

export interface RuleMeta {
  /** Стабильный идентификатор правила ('structure/dedup'). */
  id: string;
  /** Категория для отчёта ('geometry' | 'textures' | 'scene' | ...). */
  category: string;
  /** Человекочитаемое название. Готовая строка — переводится только через titleKey. */
  title: string;
  /**
   * Ключ каталога для названия. Есть — заголовок переживает смену языка; нет — в отчёт
   * идёт title как есть. Второе допустимо для правил, которых человек не видит.
   */
  titleKey?: string;
  severity: 'info' | 'warn' | 'error';
  fixSafety: FixSafety;
  /** basic — всегда; advanced — только по opt-in пользователя. */
  tier: 'basic' | 'advanced';
  /** Для advanced: id фичи из ADVANCED_FEATURES аддона. */
  feature?: string;
  /** Идентификаторы правил, после которых это должно выполниться. */
  runAfter: string[];
  /** Какие сущности трогает (для документации/анализа). */
  touches: string[];
  /** §4d: можно ли отменить результат правила. */
  reversible: boolean;
  /** §4d: значимость безвозвратно теряемых данных. */
  dataLoss: 'none' | 'minor' | 'significant';
  /** Id парного распаковывающего правила, если есть. */
  reversalRuleId?: string;
  /** Ключ каталога с пояснением об обратимости (не готовая строка — язык отдельно от кода). */
  reversalNoteKey?: string;
  /** Активно ли правило при данных опциях. */
  enabled: (opts: NormalizedOpts) => boolean;
}

/**
 * Правило пайплайна. Движок ничего не знает о его внутренностях — только вызывает
 * analyze → canFix → fix. Форма едина для всех аддонов.
 */
export interface Rule {
  meta: RuleMeta;
  /** Фаза 1: только чтение. */
  analyze: (ctx: Context) => Finding[];
  /** Доказательство безопасности. */
  canFix?: (finding: Finding, ctx: Context) => FixDecision;
  /** Фаза 3: меняет ctx.document. */
  fix?: (finding: Finding, ctx: Context) => FixResult | Promise<FixResult>;
}

export interface Finding {
  messageId: string;
  data?: Record<string, unknown>;
  text?: string;
  /** Переопределяет meta.fixSafety для конкретной находки. */
  fixSafety?: string;
}

export interface FixDecision {
  safe: boolean;
  /** Причина готовой строкой. Переживает смену языка только в паре с messageId. */
  reason?: string;
  /** Причина рецептом: ключ каталога плюс подстановки (предпочтительно). */
  messageId?: string;
  data?: MessageData;
  /** Форсировать применение выше AUTOFIX_MAX_TIER (напр. lossy по флагу). */
  force?: boolean;
}

/** Строка отчёта: готовый текст, рецепт сообщения либо несколько строк сразу. */
export type ReportLines = Message | Message[];

/** Результат fix(): строки для секций отчёта. Любое поле опционально. */
export interface FixResult {
  /** → «Найдено (проблемы)» */
  found?: ReportLines;
  /** → «Пропущено (и почему)» */
  skipped?: ReportLines;
  /**
   * → «Пропущено» с пометкой kind:'cost'. Отдельный канал от skipped, потому что смысл
   * противоположный: там «не сделали», здесь «сделали, и вот цена» (результат вырос).
   */
  cost?: ReportLines;
  /** → «Применено» */
  details?: ReportLines;
  /** синоним details */
  detail?: ReportLines;
  /** → «Применено» с dataLoss:'significant' (§4d) */
  irreversible?: ReportLines;
  /**
   * Уровень безопасности для строк irreversible. Нужен, когда разрушительная ветка
   * правила опаснее самого правила: удаление раскрашенных vertex colors — lossy, хотя
   * правило в целом numeric. Не указан — берётся meta.fixSafety (поведение до 2026-08-10).
   */
  irreversibleSafety?: FixSafety;
}

/**
 * Рабочий контекст, общий для всех правил одного файла. Движок создаёт его один раз,
 * fix-и мутируют ctx.document (и, для KTX2, переприсваивают его после roundtrip).
 * Поля io/outDir/dstName наполняет аддон — движок к ним не обращается.
 */
export interface Context {
  document: AddonDocument;
  io: AddonIO;
  opts: NormalizedOpts;
  /**
   * Путь к ИСХОДНОМУ файлу. Нужен правилам, которым важно то, что осталось за бортом
   * разбора: список расширений из самого файла по документу не восстановить — неизвестное
   * расширение библиотека при загрузке просто отбрасывает.
   */
  src: string;
  outDir: string;
  dstName: string;
  /** Обмен данными между правилами (напр. trianglesBeforeWeld). */
  cache: Map<string, unknown>;
  log: (msg: string) => void;
  /** Снимок структуры после базового прохода (ставит движок). */
  baselineMetrics?: Metrics;
}

/**
 * Опции после нормализации аддоном. Базовые поля (outDir/force/dryRun/onProgress/log)
 * читает движок; остальные (codec/texMode/... для gltf) — правила аддона.
 */
export interface NormalizedOpts {
  outDir: string;
  force: boolean;
  dryRun: boolean;
  onProgress: ((e: Record<string, unknown>) => void) | null;
  log: (msg: string) => void;
  advancedFeatures: string[];
  /** Язык отчёта. Неизвестная локаль откатывается на английский (core/i18n.mjs). */
  locale?: string;
  /** Взаимоисключающие фичи, которые разрешил аддон. Движок только отражает их в отчёте. */
  exclusiveConflicts?: ExclusiveConflict[];
  /** Поля, которые заводит и читает сам аддон (codec, texMode, safe, …). */
  [key: string]: unknown;
}

/**
 * Разрешённый конфликт взаимоисключающих фич. Решение принимает АДДОН (он знает свои
 * группы и приоритеты), движок лишь честно кладёт отказ в общий канал skipped — иначе
 * вызов по API мог бы молча потерять выбор человека.
 */
export interface ExclusiveConflict {
  /** Идентификатор группы ('geometryCompression'). */
  group: string;
  /** Правило, от чьего имени пойдёт запись в отчёт. */
  ruleId: string;
  selected: { feature: string; titleKey: string };
  rejected: Array<{ feature: string; titleKey: string }>;
}

/**
 * Минимум, который нужен движку от «того, от чьего имени идёт запись в Найдено».
 * Под эту форму подходят и RuleMeta правила, и ENGINE_META самого движка — общий предок
 * им не нужен, важна форма, а не происхождение.
 */
export interface FoundMeta {
  id: string;
  category: string;
  severity: string;
  fixSafety: string;
}

/** Что движок передаёт аддону в фазе проверки (core/engine.mjs, ФАЗА 4). */
export interface ValidateArgs {
  ctx: Context;
  before: Metrics;
  after: Metrics;
  glbBytes: Uint8Array;
  src: string;
  result: RunResult;
  /** Id правил, которые advanced-проход собирался применить. */
  advancedPlannedIds: string[];
  addFound: (meta: FoundMeta, value: ReportLines) => void;
  log: (msg: string) => void;
}

/** Что движок передаёт аддону в фазе отчёта (core/engine.mjs, ФАЗА 5). */
export interface ReportArgs {
  /** Имя итогового файла модели — от него берётся имя отчёта. */
  name: string;
  result: RunResult;
  before: Metrics;
  after: Metrics;
  /** Записан ли сам .glb: при dry-run и при провале проверки отчёт есть, файла нет. */
  assetWritten: boolean;
  opts: NormalizedOpts;
}

/**
 * Аддон формата. Движок получает его из реестра по расширению файла и делегирует ему
 * все операции, специфичные для формата (загрузка/запись/метрики/валидация/отчёт).
 */
export interface Addon {
  /** Расширения без точки ('glb', 'gltf'). */
  formats: string[];
  /** Имя выходного файла по пути исходного (для glTF — всегда .glb). */
  outputName: (src: string) => string;
  rules: Rule[];
  /** Ключи метрик, которые advanced-проход менять НЕ должен. */
  BASELINE_METRICS: string[];
  normalizeOpts: (opts: Record<string, unknown>) => NormalizedOpts;
  /** Создать/вернуть кэшированный IO с декодерами. */
  createIO: () => Promise<AddonIO>;
  /** Прочитать модель в память (рабочая копия). */
  load: (io: AddonIO, src: string) => Promise<AddonDocument>;
  /** Сериализовать в байты (без записи на диск). */
  writeBytes: (io: AddonIO, doc: AddonDocument) => Promise<Uint8Array>;
  /** Прочитать модель из байтов (для after-метрик). */
  readBytes: (io: AddonIO, bytes: Uint8Array) => Promise<AddonDocument>;
  collectMetrics: (doc: AddonDocument, fileBytes: number) => Metrics;
  /** Снимок структуры для checkpoint. */
  baselineMetrics: (doc: AddonDocument) => Metrics;
  /** Снять входное сжатие; вернуть имена снятых кодеков. */
  stripInputCompression: (doc: AddonDocument) => string[];
  /** Наполнить result.validation (специфично для формата). */
  validate: (args: ValidateArgs) => void | Promise<void>;
  /** Отрендерить и записать .report.md; вернуть имя файла. */
  writeReport: (args: ReportArgs) => string;
  /** Опционально: метаданные + валидация без оптимизации (для inspectFile()). */
  inspect?: (srcPath: string) => Promise<Record<string, unknown>>;
  /** Опционально: самодостаточный JSON-экспорт (для exportJson()). */
  toJSON?: (srcPath: string) => Promise<Record<string, unknown>>;
}

/**
 * Рецепты строк записи: поле записи → чем его пересобрать. Одним полем, а не парой
 * messageId/data на запись: у skipped рецепт нужен И тексту, И причине по отдельности.
 * Записи без рецептов поля не получают вовсе — пустой ключ только мусорил бы отчёт.
 */
export type I18nRefs = Record<string, MessageRef>;

/** Почему запись оказалась в «Пропущено». Потребителю отчёта эти случаи не равны. */
export type SkipKind =
  /** фича не включена флажком */
  | 'disabled'
  /** правило отработало, менять было нечего */
  | 'nothing'
  /** правило отказалось: небезопасно на этой модели */
  | 'unsafe'
  /** уровень риска выше того, что применяется автоматически */
  | 'policy'
  /** правило отработало, но результат вырос — цену показываем рядом с галочкой */
  | 'cost'
  /** выбрана другая фича из той же взаимоисключающей группы */
  | 'exclusive';

export interface FindingEntry {
  ruleId: string;
  category: string;
  severity: string;
  fixSafety: string;
  text: string;
  i18n?: I18nRefs;
}

export interface SkippedEntry {
  ruleId: string;
  /** Та самая галочка (advancedFeatures), а не ruleId: иначе интерфейсу пришлось бы
   *  держать свою таблицу «правило → флажок» и она разъехалась бы при переименовании. */
  feature: string | null;
  text: string;
  reason: string;
  kind: SkipKind;
  i18n?: I18nRefs;
}

export interface AppliedEntry {
  ruleId: string;
  fixSafety: string;
  /** §4d: можно ли отменить результат. */
  reversible: boolean;
  dataLoss: string;
  text: string;
  i18n?: I18nRefs;
}

export interface ValidationEntry {
  level: 'pass' | 'info' | 'fail';
  text: string;
  i18n?: I18nRefs;
}

/** Публичный контракт (docs/ARCHITECTURE.md §4b). */
export interface RunResult {
  status: 'ok' | 'skip' | 'fail';
  file: { src: string; dst: string | null; written: boolean; reportPath: string | null };
  findings: FindingEntry[];
  skipped: SkippedEntry[];
  applied: AppliedEntry[];
  validation: ValidationEntry[];
  metrics: { before: Metrics | null; after: Metrics | null };
  error?: string;
}
