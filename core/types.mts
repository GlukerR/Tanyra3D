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

export interface RuleMeta {
  /** Стабильный идентификатор правила ('structure/dedup'). */
  id: string;
  /** Категория для отчёта ('geometry' | 'textures' | 'scene' | ...). */
  category: string;
  /** Человекочитаемое название. */
  title: string;
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
  /** Причина — идёт в отчёт (в «Пропущено», если !safe). */
  reason: string;
  /** Форсировать применение выше AUTOFIX_MAX_TIER (напр. lossy по флагу). */
  force?: boolean;
}

/** Строка отчёта: готовый текст либо несколько строк сразу. */
export type ReportLines = string | string[];

/** Результат fix(): строки для секций отчёта. Любое поле опционально. */
export interface FixResult {
  /** → «Найдено (проблемы)» */
  found?: ReportLines;
  /** → «Пропущено (и почему)» */
  skipped?: ReportLines;
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
  /** Поля, которые заводит и читает сам аддон (codec, texMode, locale, …). */
  [key: string]: unknown;
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
  addFound: (meta: RuleMeta, value: unknown) => void;
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

/** Публичный контракт (docs/ARCHITECTURE.md §4b). */
export interface RunResult {
  status: 'ok' | 'skip' | 'fail';
  file: { src: string; dst: string | null; written: boolean; reportPath: string | null };
  findings: Array<{ ruleId: string; category: string; severity: string; fixSafety: string; text: string }>;
  skipped: Array<{ ruleId: string; text: string; reason: string }>;
  applied: Array<{ ruleId: string; fixSafety: string; reversible: boolean; dataLoss: string; text: string }>;
  validation: Array<{ level: 'pass' | 'info' | 'fail'; text: string }>;
  metrics: { before: Metrics | null; after: Metrics | null };
  error?: string;
}
