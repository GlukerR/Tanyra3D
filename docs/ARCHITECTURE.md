# glTF-Audit — Architecture & Design (v0, design review draft)

> Working name: **gltf-audit** (alternatives in §12). An intelligent analysis and
> optimization *orchestrator* for glTF/GLB assets — "ESLint + Lighthouse for 3D".
> It does **not** re-implement glTF-Transform / meshoptimizer / toktx. It decides
> *which* of their transforms to apply, *proves* each is safe, *validates* the result,
> and *explains* every decision.

---

## 1. Scope: what it is and is not

**Is:** a decision + explanation + validation layer on top of existing, battle-tested
libraries. The value is the *intelligence and trust*, not the transforms.

**Is not:** a new mesh processor, a new texture encoder, or a replacement for
gltfpack. If glTF-Transform already welds vertices, we call it — we never write our own weld.

Where effort goes (in priority order):
1. **Safety proof** — deciding when a fix is provably safe to auto-apply.
2. **Validation** — proving the output still renders correctly.
3. **Explanation / reporting** — the reason *why*, per finding.
4. **Extensibility** — rules, profiles, reporters as plugins.
5. **Developer experience** — CLI, CI, config.

The transforms themselves are a thin adapter layer over glTF-Transform.

---

## 1b. Competitive landscape — where we sit (map from research notes)

Positioning check against what already exists. The pattern: strong *engines* and strong
*validators* exist, but almost nobody owns the **explanation + UX** layer for the asset
author.

| Tool | Type | Does | Gap we fill |
|---|---|---|---|
| **glTF-Validator** (Khronos) | CLI/lib | Spec conformance (we *use* it in validation) | No optimization, no advice |
| **glTF-Transform** | SDK/CLI | Low-level edit/optimize (our engine) | Requires coding; no analysis narrative |
| **meshoptimizer / gltfpack** | lib/CLI | Best-in-class geometry opt for GPU | Black box; no feedback to the author on *how to fix the source* |
| **glTF Asset Auditor** | CLI/web | Pass/fail against business-req profiles (Wayfair/Target QA) | Diagnoses, does not heal; no education |
| **VNTANA Mesh Optimizer** | Desktop app | Local bulk optimize + presets | Closed, commercial; no explain-why layer |
| **RapidPipeline** | Cloud | Web platform batch optimize | Cloud-bound; not local/CLI-first |
| **Simplygon** | Enterprise | Pro auto-optimization (LOD, decimation) | Expensive enterprise; not for artists/indies |
| **Sketchfab** | Web | View/sell models | Not an optimization pipeline |

**Free niche:** the "translator from GPU-speak to artist-speak" — a tool that analyzes,
finds the bottleneck, explains *why* it matters, and applies an engine-aware, safety-proven
fix. Competition is high in *optimization engines*, low in *content-preparation UX*. Our
moat is trust + explanation, not a new compressor. Our differentiation vs each: reuse the
proven engines (never reimplement), add advice to the author, and never corrupt an asset.

---

## 2. Core architectural decisions (with challenges to the original spec)

### 2.1 Rules analyze independently, but fixes DO NOT — the engine is a DAG, not a flat list

**Challenge to "every optimization should be an independent rule."** For *analysis* this
is true and good. For *fixing* it is dangerous. glTF fixes have a mandatory order and
invalidate each other:

- `weld` must run before geometry compression, and it *creates* degenerate triangles
  (so degenerate-triangle detection must run *after* weld).
- `prune` must run last — earlier fixes orphan resources that only prune can see.
- KTX2 texture encoding must happen before geometry compression writes the container.
- Detecting an "unused UV channel" is only reliable *after* an unused material is pruned.

ESLint gets away with treating fixes as independent because text edits are cheap to
re-run to a fixpoint. Re-encoding a 4K texture is not. So:

**Rules declare a dependency DAG (`runAfter`) and a `touches` set (resource kinds).**
The engine topologically orders fixes and detects conflicts (two fixes mutating the same
resource) instead of pretending rules are order-free. This is the single most important
correction to the original design.

### 2.2 Severity and fix-safety are two independent axes

**Challenge to the single `severity` field.** A finding has two orthogonal properties:

- **Severity** — how bad is the problem? (`error` / `warn` / `info`) — drives report ordering and CI exit codes.
- **Fix-safety** — can we prove the fix is safe? (`provable` / `perceptual` / `lossy` / `none`) — drives whether we auto-apply.

They do not correlate. An oversized 8K texture is *high severity* but *lossy* to fix
(resizing changes pixels) → we report loudly, we do **not** auto-fix. A duplicate
accessor is *low severity* but *provably safe* to fix → quietly auto-fixed. Collapsing
these into one field forces bad defaults.

### 2.3 Reporting and validation are centralized, not per-rule

**Challenge to per-rule `report()` and `validate()` in the interface.** If every rule
formats its own output you cannot produce consistent JSON, SARIF, and HTML from the same
data, and formatting logic fragments across dozens of rules. ESLint rules emit structured
*messages*; *formatters* render them. We do the same:

- Rules emit structured **Findings** (data: `ruleId`, `messageId`, `data`, `severity`, locations).
- **Reporters** (json / md / html / sarif) render findings + skipped + applied + validation.
- **Validation** is a central subsystem; rules may *contribute* invariants but do not run their own validation pass.

So the real Rule interface is `analyze` / `canFix` / `fix` / optional `invariants` —
**not** the six-method shape in the spec. Smaller surface, no duplicated logic.

### 2.4 The safety taxonomy is the heart of the project

Every fix is classified into one of four tiers. This taxonomy *is* the auto-fix gate.

| Tier | Meaning | Examples | Auto-apply? |
|---|---|---|---|
| **provable** | Bit-identical render, structurally guaranteed | dedup, prune unused, remove orphan vertices, remove true-degenerate tris | Yes, always |
| **numeric** | Identical within float epsilon / declared bit budget | weld tol=0, quantization ≥ N bits | Yes, default on |
| **perceptual** | Not bit-identical, no visible difference at threshold | KTX2 UASTC high quality | Opt-in (profile decides) |
| **lossy** | Visible trade-off | simplify, texture resize, ETC1S | Never auto — recommend only |

"Automatically fix only if safety can be proven" = **only `provable` + `numeric` run by
default.** `perceptual` requires the profile to allow it. `lossy` is *never* auto-applied
— it becomes a recommendation with an optional manual `--force` override.

### 2.5 Validation has three tiers (spec conformance ≠ visual correctness)

**Challenge to relying on glTF-Validator alone.** It checks spec conformance, not that
the model looks the same. Three tiers, cheapest first:

1. **Invariants** (always, cheap): triangle count unchanged (unless lossy allowed),
   bounding box within epsilon, animation/skin/morph counts preserved, node hierarchy
   intact, every material still resolves.
2. **Spec** (always): glTF-Validator → 0 errors.
3. **Perceptual** (optional, heavy): headless render (three.js + headless-gl / GPU) of
   before & after from fixed camera angles → SSIM / pixel diff. This is the only way to
   *prove* a `perceptual`-tier fix. It is the crown jewel and the hardest subsystem —
   deferred past MVP, but the interfaces must leave room for it from day one.

The same perceptual machinery powers the GUI's visual diff (research notes): a **pixel-diff
overlay** highlighting changed pixels after texture/geometry compression, and a **geometry
error heat map** — `meshopt_simplify` returns normalized deviation (0..1, scaled by
`meshopt_simplifyScale`), written into vertex colors or a custom `_ERROR` attribute and
painted by a gradient shader so the artist *sees* where the silhouette distorted. These are
viewer-side surfaces over the same validation data, built once trust exists.

Separately, **GPU-efficiency metrics** (ACMR / ATVR / Overfetch from meshoptimizer) are
*analysis*, not validation — they don't gate the write, they feed the report ("geometry is
not GPU-cache-friendly"). They belong to the analyze phase, translated from numbers into
plain advice.

If any invariant fails, the offending fix is rolled back (working copy model makes this
cheap) and recorded as skipped-with-reason. **We never mutate the input file.**

### 2.6 Device profiles and budgets are DATA, not code

This is how one codebase serves Three.js / Mobile / Quest / Shopify without forks.

A **Profile** is a declarative file: triangle budget, texture budget, VRAM budget,
draw-call budget, allowed fix-safety tier, per-rule severity overrides, and which rule
packs are active. "Quest Score" is not code — it is `profiles/quest.json` with tight
budgets. "Shopify limits" is a profile. Rules read budgets from the active profile
instead of hardcoding numbers.

### 2.7 Scoring is penalty-based, explainable, and comes LATE

**Challenge to shipping scores early.** A wrong or unstable score destroys credibility
faster than no score (the "everyone games the Lighthouse number" problem). Model:

```
categoryScore = 100 − Σ (finding.penalty × profile.weight[finding.category])
```

Every deduction traces to a specific finding, so the score *always* explains why it is
not 100 by construction. But ship **explainable analysis first**; turn on scoring only
once the rule set and budgets are mature enough that the number is trustworthy.

---

## 3. Folder structure (pnpm monorepo, TypeScript)

```
gltf-audit/
├─ packages/
│  ├─ core/          # engine, interfaces, Context, phase runner, safety model, DAG scheduler
│  ├─ rules/         # built-in rule packs: geometry, textures, materials, uv, attributes, scene, perf
│  ├─ profiles/      # web, mobile, quest, threejs, shopify (declarative data + loader)
│  ├─ validate/      # invariants + gltf-validator wrapper + (later) headless perceptual diff
│  ├─ reporters/     # json, markdown, html, sarif
│  ├─ cli/           # command-line entry (thin — orchestrates core)
│  └─ transforms/    # thin adapters over glTF-Transform / meshopt / toktx (the ONLY place they're called)
├─ packages-optional/           # added in later phases, never blocks core
│  ├─ engines-threejs/          # engine-specific rule pack (plugin)
│  ├─ vscode/                   # extension (phase 4)
│  └─ action/                   # GitHub Action wrapper (phase 3)
├─ fixtures/         # golden test assets + expected reports (the trust backbone)
├─ docs/
└─ gltf-audit.config.ts         # example user config
```

Core has **zero** dependency on any specific rule, reporter, or profile — they are
discovered via config. Core depends only on glTF-Transform's `Document` type and the
interfaces below.

> **Статус раскладки (2026-07-24):** эта монорепо-структура — ЦЕЛЕВАЯ форма под первый
> внешний плагин, а не текущее состояние. Репозиторий сейчас ПЛОСКИЙ (`optimize2.mjs`,
> `core/`, `addons/gltf/`, `assistant.mjs`, `server.mjs`, `ui/`, `profiles/`). Переезд на
> `packages/*` — осознанное событие, когда появится ≥1 внешний пакет/плагин, а не
> «причёсывание» до того (тот же принцип, что EXTENDING §4: не платить за структуру раньше
> спроса).

---

## 4. Interfaces (design sketches — not implementation)

```ts
// ---- Findings: the data every rule emits, every reporter consumes ----
type Severity   = 'error' | 'warn' | 'info';
type FixSafety  = 'provable' | 'numeric' | 'perceptual' | 'lossy' | 'none';
type Category   = 'geometry' | 'textures' | 'materials' | 'uv' | 'attributes' | 'scene' | 'performance';
type ResourceKind = 'geometry' | 'texture' | 'material' | 'accessor' | 'node' | 'animation';

interface Finding {
  ruleId: string;            // "geometry/orphan-vertices"
  messageId: string;         // stable key → localized/rendered by reporter, not the rule
  data: Record<string, unknown>;   // counts, names, sizes — reporter formats these
  severity: Severity;
  fixSafety: FixSafety;
  target?: { kind: ResourceKind; name?: string; index?: number };
  penalty?: number;          // contribution to scoring (0 if none)
}

// ---- The rule: analyze / canFix / fix / optional invariants. No report(), no validate(). ----
interface Rule {
  meta: {
    id: string;
    category: Category;
    title: string;
    description: string;
    docsUrl?: string;
    defaultSeverity: Severity;   // overridable by profile/config
    fixSafety: FixSafety;
    runAfter?: string[];         // DAG dependency on other rule ids
    touches?: ResourceKind[];    // for fix conflict detection
  };
  analyze(ctx: Context): Finding[];                       // PURE. read-only. never mutates.
  canFix?(finding: Finding, ctx: Context): FixDecision;   // runtime safety proof for THIS asset
  fix?(finding: Finding, ctx: Context): void;             // mutates ctx.document (working copy)
  invariants?(before: Snapshot, after: Snapshot): InvariantResult[]; // optional custom checks
}

interface FixDecision {
  safe: boolean;
  reason: string;            // shown in report whether safe or not ("skipped because …")
  requiresOptIn?: FixSafety; // e.g. a perceptual fix only runs if profile allows
}

// ---- Context handed to every rule ----
interface Context {
  document: Document;        // glTF-Transform in-memory graph (the working copy)
  profile: Profile;          // active budgets + policy
  inspect: InspectReport;    // cached glTF-Transform inspect() output
  cache: Map<string, unknown>;
  log(msg: string): void;
}

// ---- Profiles are data ----
interface Profile {
  id: string;                // "quest"
  budgets: { triangles?: number; drawCalls?: number; vramMB?: number; textureMB?: number };
  allowFixSafety: FixSafety; // highest tier auto-applied ('numeric' default, 'perceptual' for web)
  severityOverrides?: Record<string, Severity>;
  weights?: Partial<Record<Category, number>>;   // scoring
  rulePacks: string[];       // which packs are active
}

// ---- Reporters ----
interface Reporter {
  id: 'json' | 'markdown' | 'html' | 'sarif';
  render(result: RunResult): string;
}
```

Key interface differences from the original spec, restated: **no per-rule `report()` or
`validate()`**; **`severity` and `fixSafety` split**; **`runAfter` + `touches` added** so
the engine can order and de-conflict fixes.

---

## 4b. КОНТРАКТ публичного API ядра (зафиксирован 2026-07-18, для v0.1.0)

> Эта секция — договор между агентами (core-engine · ai-assistant · web-interface).
> core-engine реализует раздел Б; ai-assistant и web-interface зависят ТОЛЬКО от того,
> что здесь записано, и не лезут во внутренности `optimize2.mjs`. Ломающее изменение
> контракта = явное решение с правкой этой секции, не побочный эффект рефакторинга.

### А. Фактическое API сейчас (v0.0.6) — только CLI и файлы

`optimize2.mjs` ничего не экспортирует. Весь ввод/вывод:

- **Запуск:** `node optimize2.mjs [draco] [--keep-parts] [--no-ktx] [--uastc] [--dry-run] [--strip-vertex-colors]`
- **Вход:** файлы `input/*.glb|*.gltf` (папка фиксированная). Исходники никогда не изменяются.
- **Выход:** `output/имя.glb` (только если ≥1 фикс применён И валидация прошла; в dry-run — никогда),
  отчёт `output/имя.report.md` (в dry-run: `имя.dryrun.report.md`) со секциями
  «Найдено → Пропущено (и почему) → Применено → Валидация → Оценка улучшений»,
  полный лог `logs/run_*.log` (ротация 30 дней).
- **Консольные маркеры:** `[РАБОТА] [ГОТОВО] [DRY-RUN] [ПРОПУСК] [ОШИБКА]`; итоговая строка
  `Итог: готово N, пропущено M, ошибок K`. Уже существующий `output/имя.glb` → файл пропускается.
- **Внутренние структуры** (не экспортированы, но стабильны по смыслу):
  `metrics` = `{ fileBytes, drawCalls, triangles, textureBytes, gpuBytes, meshes, materials,
  textures, nodes, scenes, animations, skins, bounds }` (треугольники/draw calls — по узлам
  сцены, skins — только действующие); `report` = `{ found[], skipped[], applied[], validation[] }`
  — массивы готовых русских строк; `RULES[i].meta` = `{ id, category, title, severity,
  fixSafety, runAfter, touches, enabled }`.

### Б. Целевой программный контракт v0.1.0 (реализует core-engine)

`optimize2.mjs` становится модулем с экспортами, CLI — тонкая обёртка над ними (поведение CLI
из раздела А сохраняется байт-в-байт).

```js
import { optimizeFile, listRules, VERSION } from './optimize2.mjs';

const result = await optimizeFile(srcPath, {
  // ГЛАВНОЕ: всё — opt-in. Пустой объект `{}` — это passthrough: файл читается,
  // валидируется и переписывается без единой оптимизации. Оптимизации включаются
  // поимённо через advancedFeatures.
  advancedFeatures: [],              // [] по умолчанию. Значения:
                                     //   'safe'          — чистка без потерь (dedup, prune, weld, вырожденные)
                                     //   'meshopt' | 'draco' — сжатие геометрии (выбор кодека)
                                     //   'join'          — flatten + объединение мешей
                                     //   'instance'      — EXT_mesh_gpu_instancing (порог: 2 узла на меш)
                                     //   'resample'      — прореживание ключей анимации
                                     //   'ktx2'          — текстуры в KTX2/UASTC
                                     //   'strip-colors'  — удалить все COLOR_n

  // Остальные флаги — уточнения к включённым фичам, camelCase (совпадают с CLI):
  codec: 'meshopt' | 'draco',        // по умолчанию 'meshopt'
  texMode: 'mixed' | 'uastc',        // по умолчанию 'uastc' — самый безопасный для новичка;
                                     // 'mixed' (ETC1S для цвета, UASTC для данных) — явным указанием
  keepParts: false,                  // не объединять части даже при 'join'
  noKtx: true,                       // KTX2 выключён, пока в advancedFeatures нет 'ktx2'
  stripColors: false, dryRun: false,
  outDir: 'output',                  // куда писать .glb и отчёт
  force: false,                      // true → обрабатывать, даже если output/имя.glb существует
  onProgress: (e) => {},             // см. события ниже; опционально
  locale: 'en',                      // язык сообщений правил; сейчас только 'en'
  log: (line) => {},                 // построчный трейс пайплайна; опционально
});
```

**Legacy-путь.** Булевы поля `safe`, `join`, `instance`, `resample`, `compress` принимаются
и напрямую — `{ safe: true }` работает так же, как `advancedFeatures: ['safe']`. Это остаток
от доopt-in версии; для новых интеграций используйте `advancedFeatures`, он единственный
описывает включённое одним списком.

**Повторная оптимизация — первоклассная операция ядра.** `optimizeFile(srcPath, opts)` —
**чистая функция от (исходник, опции)**: исходный файл никогда не мутируется (результат
пишется в `outDir`, отличный от источника — §4d), состояние между вызовами не переносится.
Поэтому одну и ту же модель можно прогонять сколько угодно раз с разными `opts`/
`advancedFeatures` и получать независимые варианты — это свойство ядра, общее для любых
форматов/аддонов (движок не знает про формат — §4a). Оптимизация ВСЕГДА идёт от исходника,
не поверх предыдущего результата (не кумулятивно). Слой представления (web/UI) вправе
кэшировать исходник, чтобы десятки/сотни итераций не перезаливали файл, но гарантия
переоптимизируемости лежит здесь, в контракте ядра.

**События `onProgress`** (для статуса фаз в UI):
`{ type: 'phase', phase: 1..5, name: 'analysis'|'plan'|'apply'|'validation'|'report' }`
(имена англоязычные — продукт англоязычный, C2) и `{ type: 'rule', phase: 3, ruleId, title }`
— перед применением каждого правила.

**Двухуровневая обработка (v0.0.9, внутренняя механика ядра):** фазы 1–3 идут двумя
проходами — сначала базовые правила (tier basic), затем checkpoint структурных метрик
`BASELINE_METRICS = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations',
'morphTargets', 'attributes']` (`vertices` — мягкий ключ, ℹ без блокировки; см. §5), затем
расширения (tier advanced; базовое правило с `runAfter` на включённое расширение уходит
во второй проход вместе с ним — порядок пайплайна сохраняется). Фаза 4 строго сверяет
метрики итоговых байтов с checkpoint: расхождение → `validation` получает `level:'fail'`
(строка «baseline-checkpoint…» при успехе, «структура геометрии изменилась…» при провале).
Так любое будущее расширение валидируется автоматически.

**Файл при провале всё равно записывается** (решение Александра, 2026-07-30). Раньше
запись блокировалась; оказалось, что это отнимает у человека выбор — иногда результат
нужен даже с оговоркой. Теперь `status` становится `'fail'`, интерфейс показывает красное
предупреждение с перечислением расхождений, но скачать файл можно. Единственное, что
по-прежнему не пишет, — `dryRun`.
События `onProgress` фаз 1–3 шлются один раз (на базовом проходе) — номера фаз для
потребителей остаются монотонными 1→5, формы событий не изменились.

**Результат `optimizeFile` (RunResult):**

```js
{
  status: 'ok' | 'skip' | 'fail',    // fail = валидация не прошла; .glb ВСЁ РАВНО записан
  file: { src, dst, written: boolean, reportPath },
  findings: [ { ruleId, category, severity, fixSafety, text } ],  // «Найдено»
  skipped:  [ { ruleId, text, reason } ],                          // «Пропущено» + причина
  applied:  [ { ruleId, fixSafety, reversible, dataLoss, text } ], // «Применено» + обратимость (§4d)
  validation: [ { level: 'pass'|'info'|'fail', text } ],           // ✅/ℹ/❌
  metrics: { before: {…}, after: {…} },   // формы из раздела А, байты без форматирования
  error?: string,                          // при исключении (модель не читается и т.п.)
}
```

`listRules()` → массив `RULES[i].meta` (read-only) — для будущих настроек/доков.
`VERSION` → строка из package.json.

**Правила стабильности:** добавлять поля можно свободно; переименование/удаление полей или
изменение семантики — ломающее изменение (правка этой секции + предупреждение зависимым
агентам). Форматирование (МБ, проценты, язык UI) — зона потребителей; ядро отдаёт числа
в байтах и готовые русские строки `text` как есть. Тексты объяснений «для человека» поверх
`RunResult` — зона ai-assistant, не ядра.

### В. Аддитивные детали реализации (2026-07-18, контракт Б реализован в optimize2.mjs)

Не меняют контракт Б — только уточнения в рамках «добавлять поля можно свободно»:

- `opts.log?: (line: string) => void` — приёмник строк хода работы (строки фаз и шагов
  правил, как в консоли CLI). По умолчанию тишина; CLI передаёт `console.log`, чем
  сохраняет прежний вывод. Библиотечный вызов без `log` ничего не печатает
  (кроме внутреннего логгера glTF-Transform — строки `prune: Removed types…`).
- Находки/применения уровня движка (вне `RULES`) имеют стабильные `ruleId` с префиксом
  `engine/`: `engine/input-compression` (снятие входного Draco/Meshopt,
  category `geometry`, fixSafety `provable`) и `engine/input-validation` (ошибки
  gltf-validator, унаследованные от входа; category `scene`, severity `warn`, fixSafety `none`).
- `file.src`, `file.dst`, `file.reportPath` — абсолютные пути; `outDir` из opts
  резолвится относительно cwd процесса. При `status:'skip'` и при раннем `fail`
  (исключение до отчёта) `reportPath: null`, `metrics.before/after: null`.
- `skipped[].reason` — причина без префикса-заголовка; для строк, которые правило вернуло
  единой фразой, `reason === text`.
- `applied[]`, `skipped[]`, `findings[]` — необязательное поле `i18n`: «рецепт» готовых
  строк записи, `{ поле записи → { messageId, data } }` (например
  `{ text: {...}, reason: {...} }`). Есть у строк, собранных из каталога сообщений; у
  строк, пришедших готовыми, его нет. `text` и `reason` остаются готовыми строками —
  потребитель, которому перевод не нужен, поля `i18n` не замечает.
  Зачем: `localizeResult(result, locale)` (`core/i18n.mjs`) пересобирает по рецептам тот
  же отчёт на другом языке из ГОТОВОГО результата. Смена языка в интерфейсе — перерисовка,
  а не работа: запускать обработку заново ради перевода нельзя.
  Подстановка в `data` сама может быть сообщением (`{ messageId, data }`) — так строка
  собирается из кусков, и переводится целиком, а не наполовину.
- `optimizeFile` кэширует один `NodeIO` (декодеры Draco/Meshopt) на процесс;
  параллельные вызовы в одном процессе не изолированы по CPU — очередь на стороне потребителя.

---

## 4c. Контракт слоя ассистента (v0.1.0)

> Эта секция — договор между агентами (ai-assistant · web-interface). Реализует
> ai-assistant в `assistant.mjs`. web-interface зависит ТОЛЬКО от того, что здесь записано.
> `assistant.mjs` **не импортирует** `optimize2.mjs`: ядро вызывает web-interface, а слой
> ассистента лишь переводит `RunResult` (§4b) на человеческий язык. Профили платформ —
> ДАННЫЕ (`profiles/*.json`): новая платформа = новый json-файл без правки кода ассистента.
> Ломающее изменение контракта = правка этой секции + предупреждение web-interface.

### Экспорты `assistant.mjs`

```js
import { listPlatforms, planFor, explainResult } from './assistant.mjs';

// Список платформ для выпадающего меню UI (читается из profiles/*.json).
listPlatforms()
// → [ { id, title, description } ]

// План обработки под платформу: engineOpts передаются в optimizeFile КАК ЕСТЬ.
planFor(platformId)
// → {
//     profileId,                 // id профиля
//     title,                     // человеческое имя платформы
//     engineOpts,                // ровно opts из §4b (codec, texMode, keepParts, noKtx, stripColors)
//     explanation: [ string ],   // почему выбраны эти настройки, без жаргона
//   }

// Перевод RunResult (§4b) на человеческий язык для правой панели «Анализ».
explainResult(runResult, platformId)
// → {
//     summary: string,           // 1–2 предложения: файл/видеопамять с числами
//     highlights: [ string ],    // главные улучшения человеческим языком (макс. 5–6)
//     budgetChecks: [ { name, limitText, actualText, ok: boolean, advice?: string } ],
//     warnings: [ string ],      // из skipped и validation уровней info|fail
//   }
```

**Семантика и правила:**

- **Форматирование — зона ассистента.** Ядро отдаёт `metrics` в байтах (§4b); ассистент
  сам переводит в КБ/МБ и проценты внутри текстов. web-interface тексты не пересчитывает,
  только отображает как карточки-issues с цветовой маркировкой по полю `ok`.
- **budgetChecks** сверяют `metrics.after` c `profile.budgets`. Проверяются только
  измеримые метрики: `triangles`, `drawCalls`, `vramMB` (← `gpuBytes`), `fileMB`
  (← `fileBytes`). `textureMaxSize` пока не проверяется — ядро не отдаёт размерность
  текстур в `metrics`. При превышении (`ok:false`) `advice` объясняет, что превышено, на
  сколько и что делать при экспорте.
- **Рост файла при падении видеопамяти — НЕ ошибка.** Объясняется нейтрально: GPU-формат
  текстур тяжелее в файле, зато на видеокарте занимает в разы меньше.
- **Неизвестный `platformId`** → выброс `Error` с понятным текстом и списком доступных id.
- **Нештатные статусы `RunResult`** (`error` / `status:'skip'` / `metrics === null`)
  дают осмысленный `summary` и пустые массивы там, где данных нет.

### Формат `profiles/*.json`

```json
{
  "id": "shopify",
  "title": "Shopify",
  "description": "1–2 предложения для пользователя без жаргона",
  "budgets": {
    "triangles": 150000,
    "drawCalls": 25,
    "textureMaxSize": 2048,
    "vramMB": 100,
    "fileMB": 15
  },
  "baselineOpts": {
    "codec": "meshopt",
    "texMode": "uastc",
    "keepParts": false,
    "noKtx": true,
    "stripColors": false
  },
  "notes": [ "источник/обоснование каждого бюджета" ]
}
```

- `baselineOpts` — ровно поля `opts` из §4b (camelCase), передаются в `optimizeFile` без
  преобразования. Это БАЗОВЫЙ план платформы: KTX2 и Draco в него не входят, они
  включаются пользователем через `advancedFeatures`.
- Поле `engineOpts` в файле профиля — **устаревшее имя**. `assistant.mjs:122` читает его
  как фолбэк (`profile.baselineOpts || profile.engineOpts`), но новые профили должны
  использовать `baselineOpts`. Не путать с полем `engineOpts` в **ответе** `planFor()` —
  там имя осталось прежним и менять его незачем.
- `budgets` в человеческих единицах: `textureMaxSize` — пиксели, `vramMB`/`fileMB` — МБ,
  `triangles`/`drawCalls` — штуки. Ассистент сам переводит МБ бюджета в байты при сверке.
- `notes` — обоснование каждого бюджета (источник: рекомендации Khronos 3D Commerce,
  официальные лимиты платформы, рекомендации Meta для Quest; либо консервативный «ориентир»).
- Файл кладётся в `profiles/`, имя файла = `<id>.json`. Больше ничего регистрировать не нужно.

---

### Progressive disclosure — уровни объяснения (v0.1.0: 3 уровня)

Каждое объяснение решения подаётся слоями: по умолчанию пользователь видит только верхний
уровень, глубже разворачивает по желанию. Один интерфейс обслуживает и новичка, и эксперта —
не перегружая первого и не раздражая второго.

Для v0.1.0 — ровно **три уровня** (визуализация и ссылки на спеку — позже, не на MVP):

1. **Человеческий** (по умолчанию) — что произошло и почему, на языке художника.
   Пример: «Текстуры были 4096×4096. Для мобильной цели это ~64 МБ видеопамяти. Уменьшил
   до 2048×2048 — экономия 75% памяти, разница на глаз незаметна».
2. **Технические детали** (разворот) — имя правила, категория безопасности (§2.4),
   числа до/после, ссылки `references` из метаданных правила (§4d).
3. **Сырые метрики** (разворот) — необработанные данные `RunResult` (§4b): счётчики,
   размеры, тайминги.

Владельцы: `ai-assistant` формирует содержимое всех трёх уровней в `RunResult`;
`web-interface` отвечает только за подачу (сворачивание/разворачивание). Уровень 1 всегда
присутствует; уровни 2–3 не обязательны, если данных нет.

---

## 4d. Принцип обратимости (фундамент универсального трансформера)

v0.0.8+ закладывает архитектуру **универсального трансформера моделей**, не просто оптимизатора. 
Каждое сжатие/преобразование имеет обратную операцию (если возможно).

### Типы обратимости

- **✅ Полностью обратимо** (no data loss): Draco ↔ стандартный формат, Meshopt ↔ стандартный
- **⚠️ Обратимо с потерей** (minor): KTX2 ↔ PNG/WebP (потеря от BASIS-U распаковки, зависит от параметров кодирования)
- **❌ Невозвратно**: Decimation (полигоны удалены), flatten/join (структура потеряна), strip-colors (данные удалены)

### Метаданные правила

Каждое `rule.meta` содержит:
- `reversible: boolean` — есть ли обратное?
- `reversalRuleId?: string` — id обратного правила (если есть)
- `reversalNote?: string` — описание для пользователя
- `dataLoss?: 'none' | 'minor' | 'significant'` — потеря данных: для обратимых — при распаковке; для необратимых — насколько значимы безвозвратно потерянные данные (`none` = удалено только неиспользуемое/идентичное, `significant` = потеряна структура или видимое содержимое)
- `references?: string[]` — ссылки на официальную документацию/спеку, обосновывающие правило (в духе принципа открытых источников — см. `ЗАВИСИМОСТИ.md`: не выдумываем правила из головы). Показываются в отчёте на уровне «технические детали» (см. §4c, progressive disclosure).

### Режимы использования (для будущего UI)

- **Оптимизация**: для целевой платформы (базовые + расширения сжатия → результат)
- **Распаковка**: обратно в стандартный формат (для других целей, игр, печати, etc.)
- **Переформатирование**: перекодирование (Meshopt → Draco, WebP → KTX2)

На v0.1.0 реализованы основные пары (Draco, KTX2). На будущее: расширить на все правила 
и добавить UI-режимы для распаковки.

**Важно:** Когда пользователь скачивает результат с невозвратными изменениями (decimation, strip-colors, etc.) → 
показывать warning: _«Применены необратимые изменения. Сохраните исходный файл перед скачиванием.»_

Реализовано (v0.0.8): каждая запись `applied` несёт `reversible`/`dataLoss` из meta правила
(lossy-ветка внутри правила может пометить свои строки отдельно — `res.irreversible` в fix());
UI показывает предупреждение над кнопкой скачивания, если среди применённого есть
`reversible: false` + `dataLoss: 'significant'`, со списком конкретных изменений.

---

## 4e. Core Engine как единая платформа приложения (спецификация Александра, 2026-07-23)

> Записано как требование, НЕ как реализация. Разбор по срокам (что делаем до 0.1.0, что
> сейчас, что потом) — в `ROADMAP.md` §5c. Здесь — авторитетная фиксация: какие модули
> обязательны, что они общие для всех движков/форматов, и как это ложится на уже принятые
> контракты §4a–§4d и `EXTENDING.md`.

### Терминология: два смысла «Core Engine»

В §4a–§4d «ядро» = формат-агностичный движок оптимизации (`optimize2.mjs`): без UI, чистая
функция `(исходник, опции) → RunResult`. Александр использует «Core Engine» в БОЛЕЕ ШИРОКОМ
смысле — как **постоянный слой приложения**, общий для всех будущих движков просмотра
(three.js сейчас; Unreal, Unity и др. потом) и всех форматов. В этот слой входят, помимо
движка оптимизации: оболочка UI, обвязка вьюпортов, менеджеры файлов и текстур, единые
модули Metadata/Validation, логи, экспорт. Оба смысла совместимы: широкий Core Engine — это
узкое ядро оптимизации ПЛЮС общая оболочка. Ниже «платформенный слой» = широкий смысл.

Это прямое продолжение `EXTENDING.md` §1 («маленькое ядро + всё как плагины: importers,
exporters, viewers, profiles…») и §4a (движок не знает про формат). Новое здесь — явно
зафиксировано, что **оболочка приложения тоже часть постоянного слоя**, а не часть
three.js-реализации.

### Принцип (пункт 13 спецификации)

При смене платформы/движка меняются РОВНО три вещи:
1. **движок вьюпорта** (three.js → Unreal/Unity/…);
2. **содержимое окон Metadata и Validation** — какие данные и какие проверки, зависит от формата;
3. **список опций оптимизации справа** — свой у каждой платформы.

Логика действий (загрузка, менеджер моделей, менеджер текстур, управление камерами, сброс,
сравнение before/after, кнопка Build, экспорт, логи) — **одна и та же на любом движке**.
Новый движок/импортёр/экспортёр/плагин НЕ реализует эти возможности заново — он
подключается к существующим модулям платформенного слоя через единый API. Уже действующий
пример шва — контракт движка просмотра у `createViewer()` (`ui/viewer/index.js`): очистка
полотна при сбросе живёт в обвязке `ViewportSlot.reset()`, а не в three.js-движке, поэтому
новый движок получает это поведение бесплатно (см. CONTEXT 2026-07-23 (5)).

### Обязательные модули платформенного слоя (13 пунктов) и их статус

| # | Модуль | Обязан давать | Статус сейчас | Владелец-шов / ссылка |
|---|---|---|---|---|
| 1 | Загрузка файлов | приём любого поддерживаемого формата (D&D + выбор), UI не меняется при новом формате | GLB-only; UI-текст «Drop a .glb file» | Importer `bytes→Document` (`EXTENDING.md` §2); §4a |
| 2 | Менеджер файлов | список ≥5 моделей: имя, формат, путь, статус, текстуры, метаданные | нет (одна модель, `purgeSourcesExcept`) | новый модуль; в UI уже задел `.outliner`/`model-list` |
| 3 | Менеджер текстур | D&D/выбор текстур, привязка к модели, замена, удаление; общий для всех импортёров | нет | новый модуль |
| 4 | Левая панель (Original) | Original Mesh · File · Tris · Vertices · Draw Calls · Materials · Textures | есть (`renderOriginalStats`, HUD) | платформенный слой; общий вид на любом движке |
| 5 | Правая панель (Optimized) | Optimized Mesh · % (+/−) · File · Tris · Vertices · Draw Calls · Materials · Textures | есть (`renderComparison`, delta-бейдж) | платформенный слой |
| 6 | Управление вьюпортом | вращение обеих сразу, зум, панорама, Reset Camera, синхронизация | есть (`DualViewport`, linked cameras, `resetView`) | контракт `createViewer()` |
| 7 | Сравнение Original/Optimized | разделитель, изменяемая ширина, синхронная навигация, будущее отключение синхр. | есть (`viewport-split`, splitter, тумблер связи камер) | платформенный слой |
| 8 | Metadata | ЕДИНЫЙ модуль; новый формат лишь добавляет свои данные, не заводит свою Metadata | есть как формат-агностичный шов | `inspect()` addon-хук → `inspectFile()` (§4a, реализовано) |
| 9 | Validation | ЕДИНЫЙ модуль; новый формат лишь добавляет свои проверки (Geometry/UV/Materials/Textures/Animations/Skeleton/Cameras/Lights/Extensions/…) | есть как шов; набор проверок = подмножество | §2.3 (валидация централизована), §2.5 (три уровня), `inspect()` |
| 10 | Build / Optimize | главная кнопка; результат сам появляется в правом вьюпорте | есть (`run-btn` → `loadOptimized`) | §4b `optimizeFile` |
| 11 | Download Result | ОДНА кнопка → окно экспорта (формат/имя/место); UI не меняется при новом экспортёре | сейчас две кнопки (GLB + Export JSON), без диалога | Exporter `Document→bytes` (`EXTENDING.md` §2); §4d |
| 12 | Логи | все действия Core Engine пишутся в лог (загрузка, текстура, импорт, старт/финиш оптимизации, Validation, Metadata, экспорт, ошибки, предупреждения) | есть (панель+окно логов, события); часть событий ждёт своих фич | реализовано 2026-07-23 (3) |
| 13 | Архитектура | единый UI + единый Core; расширяется только функциональность форматов | принцип; согласуется с `EXTENDING.md` §1–2, §4a | этот раздел |

### Как это ложится на существующие контракты (сверка, без противоречий)

- **§4a (формат-агностичность ядра)** — прямо поддерживает пункты 8/9/13: Metadata и
  Validation уже сделаны как единый шов (`inspectFile` → addon `inspect()`), новый формат
  реализует тот же хук со своими данными. Расширять набор проверок Validation (Skeleton,
  Cameras, Lights…) — это добавление в существующий модуль, не новый модуль на формат.
- **§4c (профили-данные)** — пункт «список опций справа меняется по платформе» уже так и
  устроен: опции строятся из `availableExtensions` профиля (`profiles/*.json`), новая
  платформа = новый json. Дополнительной архитектуры не нужно.
- **§4d (обратимость, экспортёры)** — пункт 11 (Download Result) ложится на Exporter-шов:
  один диалог, форматы добавляются как экспортёры-плагины без правки UI. Оговорка среды:
  выбор ПРОИЗВОЛЬНОГО места сохранения в браузере ограничен (нужен File System Access API,
  только Chromium); честный минимум — выбор формата и имени, «место» — штатная папка
  загрузок. Полноценный «Save As» — только в десктоп-оболочке (ROADMAP §7) либо через
  Chromium-only API как прогрессивное улучшение.
- **`EXTENDING.md` §2 (типизированные точки расширения)** — пункты 1/11 (импорт/экспорт
  форматов) уже имеют контракты (`bytes→Document`, `Document→bytes`); НЕ-glTF экспорт (FBX,
  USDZ) остаётся «стеной» из ROADMAP §4/§7, независимо от готовности UI-диалога.

### Что это меняет в приоритетах (кратко; полный разбор — ROADMAP §5c)

Спецификация НЕ вводит новых архитектурных принципов — она делает явным, что оболочка
приложения принадлежит постоянному слою, и даёт чек-лист обязательных модулей. Часть уже
реализована и лишь формализуется как «Core Engine, общий для движков» (пп. 4–10, 12); часть
— дешёвые правки UI сейчас (текст загрузки, объединение экспорта в одну кнопку+диалог);
часть — новые подсистемы на потом (менеджер моделей ≥5, менеджер текстур, не-glTF
импорт/экспорт). Разбор по корзинам — в ROADMAP §5c.

---

## 4f. Две плоскости: Inspect и Processing (glTF — рабочий стол, не универсальная модель) (2026-07-24)

> Зафиксировано по итогам архитектурной сессии с Александром. Уточняет §4a: раньше «ядро
> работает на модели glTF-Transform `Document`» можно было прочитать как «любой ассет
> ОБЯЗАН стать glTF». Это НЕ так. Решения приняты Александром; уточнения Клода, не
> оспоренные в ходе сессии, считаются принятыми (прямое указание Александра).

**Простыми словами.** glTF — это рабочий стол в мастерской, а не паспорт, который обязан
получить каждый ассет. Когда ты просто СМОТРИШЬ модель — смотришь в её родном формате, стол
не нужен. Когда ты что-то ДЕЛАЕШЬ с моделью (сжать, оптимизировать, показать) — кладёшь на
стол, работаешь, забираешь результат. Стол один для всех, но модель не становится столом
навсегда.

### Две плоскости

1. **Inspect-плоскость («посмотреть»).** Нативные providers по форматам (glTF; потом FBX,
   USD, OBJ…). Формат читается КАК ЕСТЬ, без принудительной конверсии в glTF. Назначение:
   метаданные, бюджеты платформы, проверки совместимости. USD/FBX и всё, что не влезает в
   форму glTF, живёт ЗДЕСЬ нативно.

2. **Processing-плоскость («поработать»).** Пайплайн на базе glTF (glTF-Transform,
   meshoptimizer, KTX tools). Конверсия в glTF — промежуточный build-шаг и ТОЛЬКО там, где
   нужны операции, зависящие от glTF-экосистемы (geometry-компрессия, KTX2 и т.п.).

**Граница одной фразой:** glTF нужен там, где ты ДЕЛАЕШЬ или РИСУЕШЬ (оптимизация, рендер).
Не нужен там, где только СМОТРИШЬ (метаданные, бюджеты).

### Почему на Processing-плоскости glTF-хаб обязателен (а не «один из вариантов»)

Проект решил (§1, MISSION) НИКОГДА не переписывать движки оптимизации — только вызывать
готовые (glTF-Transform / meshopt / toktx). Эти движки glTF-нативны. Значит нельзя
одновременно «нет обязательного хаба» И «переиспользуем готовые движки»: правило meshopt
физически не запускается на модели FBX. Хаб на Processing-плоскости — прямое СЛЕДСТВИЕ
решения не переписывать движки. Отказ от движков ради «нативной оптимизации каждого
формата» = «12 полурабочих оптимизаторов» = failure mode «распыление» (ROADMAP §8).

### Providers

Задача провайдера формата — загрузить ассет, дать данные для инспекции и (где возможно)
сохранить корректный экспорт. Но: ЧИТАТЬ чужие форматы — легко; ПИСАТЬ обратно в не-glTF
(FBX, USDZ) — «стена» (Autodesk/Apple SDK, ROADMAP §4/§7). Слово «provider» стену не
отменяет. Поэтому providers сначала — в основном про ЧТЕНИЕ/инспекцию, не про запись.

**Source-ассеты никогда не мутируются** (подтверждение §4d, §6): работаем на копии,
исходник неприкосновенен.

### Viewport = Preview Representation

Вьюпорт — потребитель `RunResult` (§4b), а не стадия пайплайна и не нативный рендерер
каждого формата. Он показывает УДОБНУЮ для показа форму (Preview Representation), а не
рендерит USD/FBX/… каждый по-своему. Это снимает стоимость «учить вьюпорт рисовать все
форматы».

### Как думать о декомпозиции (вместо «6 слоёв в столбик»)

Три ортогональные вещи, не один столбик слоёв:
- **Пайплайн (стадии):** load → analyze → plan → apply → validate → report (§5).
- **Точки расширения (плагины):** Importer / Exporter / Rule / Profile / Reporter / Viewer
  (EXTENDING §2).
- **Поверхности (потребители контракта):** Web (Tanyra3D) / CLI / Desktop / CI.

И две НЕЗАВИСИМЫЕ оси: **ось формата** (что читаем/пишем) ≠ **ось цели** (под какую среду
готовим). Модель может быть FBX-на-входе → Shopify-на-цели: формат и цель не связаны.

### Что это НЕ меняет

MVP остаётся GLB/Web (ROADMAP §5e). Всё выше — форма расширения на будущее, а не переделка
текущего. На вебе glTF одновременно и рабочий стол, и целевой формат — обе плоскости
совпадают, поэтому СЕГОДНЯ разделение невидимо; оно становится важным, когда придут не-glTF
входные форматы (0.3.x и далее).

---

## 5. Data flow (five phases)

```
load asset (glTF-Transform NodeIO, all extensions + decoders registered)
   → Document (in-memory graph) + cached inspect()
        │
   PHASE 1 · ANALYZE   (read-only, parallelizable across rules)
        for each enabled rule: analyze(ctx) → Finding[]
        │
   PHASE 2 · PLAN
        collect findings; for each fixable finding call canFix()
        keep only findings whose fixSafety ≤ profile.allowFixSafety AND canFix().safe
        topologically sort surviving fixes by runAfter + known pipeline order
        detect conflicts via `touches`; serialize or drop with recorded reason
        │
   PHASE 3 · APPLY   (sequential, mutates a working copy — input file untouched)
        for each planned fix: snapshot → fix() → per-fix invariant check
        invariant fails → roll back that fix, record as skipped(reason)
        │
   PHASE 4 · VALIDATE   (whole-asset)
        invariants (tris/bounds/anim/skin/hierarchy) → gltf-validator → (opt) perceptual diff
        any hard failure → roll back run, emit report explaining why, write nothing
        │
   PHASE 5 · REPORT
        reporters render: Problems found / Skipped(+reason) / Applied / Validation / Scores / Estimated improvements
        write optimized asset ONLY if fixes applied AND validation passed
        write report(s) alongside
```

---

## 6. Edge cases the design must handle (senior review)

- **Input already optimized** — KTX2 textures, existing Draco/Meshopt: detect and skip re-encoding (re-encoding a `perceptual` asset compounds loss). Decode-on-load, re-encode only if beneficial.
- **WebP/JPEG texture input** — toktx reads only PNG/JPEG; WebP must be losslessly decoded first (already learned the hard way in the prototype).
- **`.gltf` with external buffers/images** — glTF-Transform resolves the set; always output a single `.glb`.
- **Multiple scenes** — process all, not just scene 0.
- **Non-triangle primitives** (POINTS/LINES) — never run triangle-only passes (weld, degenerate) on them.
- **Vertex colors that are actually used** — `COLOR_0` multiplies baseColor; only auto-remove if provably constant-white, else recommend with `--force`.
- **Double-sided materials** — `doubleSided:true` on a closed mesh wastes backface overdraw, but disabling it silently breaks genuinely two-sided surfaces (foliage, cloth, zero-thickness planes). Detect and *recommend*, never auto-disable; a platform profile (web/mobile) may opt in.
- **UV channel removal requires renumbering** — removing `TEXCOORD_0` while `_1` is used means rewriting every material's texCoord index and any `KHR_texture_transform`.
- **Extension-referenced resources** — a UV set or texture used only by a material extension (clearcoat, sheen, transmission) must not read as "unused". Analysis must be extension-aware.
- **Draco vs Meshopt already present** — round-trip decode/encode, don't stack.
- **Fixes that conflict** — two rules touching the same accessor: serialize by DAG or drop the lower-priority one with a recorded reason.
- **Determinism** — same input + same config ⇒ byte-identical report and asset (CI caching, regression diffs). No timestamps in the hashed output; no `Math.random`.
- **Never mutate input** — always write to a new path; the source file is sacred.
- **Large assets / memory** — stream where glTF-Transform allows; cap in-memory decode.
- **False positives** — users need a suppression mechanism (config-level `ignore` per rule/target), because "never modify if unsafe" means they must be able to override our caution *and* our noise.

---

## 8. Testing & trust strategy (non-negotiable)

An optimizer that corrupts one asset loses the community permanently. Trust is engineered:

- **Golden-asset corpus** in `fixtures/`: a curated set of real-world glTFs (skinned,
  morph targets, multi-material, KTX2, Draco, extension-heavy, degenerate-on-purpose)
  each with an **expected report snapshot**. Every PR runs the whole corpus; any change in
  output is a reviewed diff.
- **Property-based invariants** on fixes: for a fix claiming `provable`, assert
  bit-identical render-relevant data; for `numeric`, assert within declared epsilon.
- **`--dry-run`** everywhere: show what *would* change without touching bytes.
- **Deterministic output** so snapshots are stable.

---

## 9. Config (flat, ESLint-style)

```ts
// gltf-audit.config.ts
export default {
  profile: 'web',                       // or path to custom profile
  rulePacks: ['@gltf-audit/rules'],     // + community packs
  autofix: 'numeric',                   // highest tier applied without --force
  ignore: [
    { rule: 'attributes/vertex-colors', target: 'Plane.017' }, // suppression = override our caution
  ],
  severityOverrides: { 'textures/missing-ktx2': 'error' },
  reporters: ['markdown', 'sarif'],
};
```

---

## 10. Missing functionality the spec did not list (a maintainer needs these)

- **Baseline / regression diff** — compare to a stored report, fail CI on regression. Essential for the CI/CD story.
- **SARIF output** — GitHub code-scanning integration; makes findings appear inline on PRs. High leverage, low cost.
- **Suppression / ignore** — inline or config, for false positives and intentional choices.
- **Deterministic, reproducible output** — for CI caching and trustworthy diffs.
- **Caching** — hash asset+config, skip unchanged.
- **`--dry-run` / suggestions vs apply** — separate "tell me" from "do it".
- **Zero telemetry by default** — open-source trust.
- **Never-in-place writes** — source file immutable, always new output path.

---

## 11. Open decisions for the product owner

1. **Language: TypeScript** (recommended — glTF-Transform is TS-first, type-safety was a stated goal) vs anything else. I strongly recommend TS.
2. **Monorepo tool**: pnpm workspaces (recommended) vs Nx/Turborepo (more machinery, later).
3. **License**: MIT (max adoption, recommended) vs Apache-2.0 (patent grant). Both permissive.
4. **Scope of v1 autofix**: `provable`+`numeric` only (recommended) — do we ever want `perceptual` on by default for the `web` profile?
5. **Name** (§12).

---

## 12. Name candidates

`gltf-audit` · `meshlint` · `polylint` · `gltf-doctor` · `prism` · `facet`.
My lean: **gltf-audit** (says what it does, SEO-clean) or **meshlint** (the ESLint echo is
the whole positioning). Product owner's call.

---

## 13. One-paragraph summary

Build a TypeScript monorepo whose `core` is a rule *engine* — rules analyze in parallel
(read-only), the engine plans fixes as a dependency DAG gated by a four-tier safety
taxonomy, applies only provably-safe fixes to a working copy, validates via invariants +
gltf-validator (+ later perceptual diff), and central reporters render the explained
result. Transforms are thin adapters over glTF-Transform / meshopt / toktx — never
reimplemented. Device targets are declarative profiles, not code. Ship a deep,
trustworthy analyze-only CLI first; earn trust with a golden-asset test corpus before
autofix; layer scoring, CI, and GUI surfaces onto the same core afterward.
