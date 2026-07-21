// core/types.mjs — формы данных движка (JSDoc, без TypeScript). Модуль не содержит
// исполняемого кода: только типы-документация, на которые ссылаются engine.mjs,
// registry.mjs и аддоны. Контракт публичного API (RunResult, optimizeFile) —
// docs/ARCHITECTURE.md §4b; границы core/addon — Правило 3 CLAUDE.md.

/**
 * @typedef {Object} RuleMeta
 * @property {string} id                 Стабильный идентификатор правила ('structure/dedup').
 * @property {string} category           Категория для отчёта ('geometry'|'textures'|'scene'|...).
 * @property {string} title              Человекочитаемое название.
 * @property {'info'|'warn'|'error'} severity
 * @property {'provable'|'numeric'|'perceptual'|'lossy'} fixSafety  Доказуемость безопасности фикса.
 * @property {'basic'|'advanced'} tier   basic — всегда; advanced — только по opt-in пользователя.
 * @property {string} [feature]          Для advanced: id фичи из ADVANCED_FEATURES аддона.
 * @property {string[]} runAfter         Идентификаторы правил, после которых это должно выполниться.
 * @property {string[]} touches          Какие сущности трогает (для документации/анализа).
 * @property {boolean} reversible        §4d: можно ли отменить результат правила.
 * @property {'none'|'minor'|'significant'} dataLoss  §4d: значимость безвозвратно теряемых данных.
 * @property {string} [reversalRuleId]   Id парного распаковывающего правила, если есть.
 * @property {string} [reversalNote]     Пояснение об обратимости для отчёта/UI.
 * @property {(opts: NormalizedOpts) => boolean} enabled  Активно ли правило при данных опциях.
 */

/**
 * Правило пайплайна. Движок ничего не знает о его внутренностях — только вызывает
 * analyze → canFix → fix. Форма едина для всех аддонов.
 * @typedef {Object} Rule
 * @property {RuleMeta} meta
 * @property {(ctx: Context) => Finding[]} analyze          Фаза 1: только чтение.
 * @property {(finding: Finding, ctx: Context) => FixDecision} [canFix]  Доказательство безопасности.
 * @property {(finding: Finding, ctx: Context) => (FixResult|Promise<FixResult>)} [fix]  Фаза 3: меняет ctx.document.
 */

/**
 * @typedef {Object} Finding
 * @property {string} messageId
 * @property {Object} [data]
 * @property {string} [text]
 * @property {string} [fixSafety]   Переопределяет meta.fixSafety для конкретной находки.
 */

/**
 * @typedef {Object} FixDecision
 * @property {boolean} safe
 * @property {string} reason        Причина — идёт в отчёт (в «Пропущено», если !safe).
 * @property {boolean} [force]      Форсировать применение выше AUTOFIX_MAX_TIER (напр. lossy по флагу).
 */

/**
 * Результат fix(): строки для секций отчёта. Любое поле опционально.
 * @typedef {Object} FixResult
 * @property {string|string[]} [found]        → «Найдено (проблемы)»
 * @property {string|string[]} [skipped]      → «Пропущено (и почему)»
 * @property {string|string[]} [details]      → «Применено»
 * @property {string|string[]} [detail]       синоним details
 * @property {string|string[]} [irreversible] → «Применено» с dataLoss:'significant' (§4d)
 */

/**
 * Рабочий контекст, общий для всех правил одного файла. Движок создаёт его один раз,
 * fix-и мутируют ctx.document (и, для KTX2, переприсваивают его после roundtrip).
 * Поля io/outDir/dstName наполняет аддон — движок к ним не обращается.
 * @typedef {Object} Context
 * @property {any} document           Рабочая копия модели (для gltf — Document @gltf-transform/core).
 * @property {any} io                 IO аддона (для gltf — NodeIO с декодерами).
 * @property {NormalizedOpts} opts
 * @property {string} outDir
 * @property {string} dstName
 * @property {Map<string, any>} cache Обмен данными между правилами (напр. trianglesBeforeWeld).
 * @property {(msg: string) => void} log
 * @property {Object} [baselineMetrics]  Снимок структуры после базового прохода (ставит движок).
 */

/**
 * Опции после нормализации аддоном. Базовые поля (outDir/force/dryRun/onProgress/log)
 * читает движок; остальные (codec/texMode/... для gltf) — правила аддона.
 * @typedef {Object} NormalizedOpts
 * @property {string} outDir
 * @property {boolean} force
 * @property {boolean} dryRun
 * @property {((e: Object) => void)|null} onProgress
 * @property {(msg: string) => void} log
 * @property {string[]} advancedFeatures
 */

/**
 * Аддон формата. Движок получает его из реестра по расширению файла и делегирует ему
 * все операции, специфичные для формата (загрузка/запись/метрики/валидация/отчёт).
 * @typedef {Object} Addon
 * @property {string[]} formats                     Расширения без точки ('glb','gltf').
 * @property {Rule[]} rules
 * @property {string[]} BASELINE_METRICS            Ключи метрик, которые advanced-проход менять НЕ должен.
 * @property {(opts: Object) => NormalizedOpts} normalizeOpts
 * @property {() => Promise<any>} createIO          Создать/вернуть кэшированный IO с декодерами.
 * @property {(io: any, src: string) => Promise<any>} load       Прочитать модель в память (рабочая копия).
 * @property {(io: any, doc: any) => Promise<Uint8Array>} writeBytes  Сериализовать в байты (без записи на диск).
 * @property {(io: any, bytes: Uint8Array) => Promise<any>} readBytes Прочитать модель из байтов (для after-метрик).
 * @property {(doc: any, fileBytes: number) => Object} collectMetrics
 * @property {(doc: any) => Object} baselineMetrics  Снимок структуры для checkpoint.
 * @property {(doc: any) => string[]} stripInputCompression  Снять входное сжатие; вернуть имена снятых кодеков.
 * @property {(args: ValidateArgs) => void} validate  Наполнить result.validation (специфично для формата).
 * @property {(args: ReportArgs) => string} writeReport  Отрендерить и записать .report.md; вернуть имя файла.
 */

/**
 * @typedef {Object} RunResult   Публичный контракт (docs/ARCHITECTURE.md §4b).
 * @property {'ok'|'skip'|'fail'} status
 * @property {{src:string, dst:string|null, written:boolean, reportPath:string|null}} file
 * @property {Array<{ruleId:string, category:string, severity:string, fixSafety:string, text:string}>} findings
 * @property {Array<{ruleId:string, text:string, reason:string}>} skipped
 * @property {Array<{ruleId:string, fixSafety:string, reversible:boolean, dataLoss:string, text:string}>} applied
 * @property {Array<{level:'pass'|'info'|'fail', text:string}>} validation
 * @property {{before:Object|null, after:Object|null}} metrics
 * @property {string} [error]
 */

export {}; // модуль только с типами — исполняемых экспортов нет
