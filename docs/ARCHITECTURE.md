# glTF-Audit — Architecture & Design (v0, design review draft)

> Working name: **gltf-audit** (alternatives in §12). An intelligent analysis and
> optimization *orchestrator* for glTF/GLB assets — "ESLint + Lighthouse for 3D".
> It does **not** re-implement glTF-Transform / meshoptimizer / toktx. It decides
> *which* of their transforms to apply, *proves* each is safe, *validates* the result,
> and *explains* every decision.

---

## 0. Принцип открытых источников (Dependency Documentation)

**Фундаментальное правило:** Каждое решение в этом проекте опирается на **официальную документацию компонентов, которые мы используем**. Не придумываем свои правила из головы.

### Процесс добавления компонента или изменения его использования:

1. **Найти источник:** смотреть `package.json` → `repository` и `homepage` 
   - Пример: `draco3dgltf` → https://github.com/google/draco (версия 1.5.7)
   - Пример: `@gltf-transform/core` → https://github.com/donmccurdy/glTF-Transform + https://gltf-transform.dev/

2. **Читать их документацию:** GitHub README, официальные docs, issues, changelog
   - Что компонент гарантирует? Что может сломаться? Какие особенности?
   - Примеры: Draco квантизирует вершины → может меняться количество треугольников? KTX2 может быть потеря качества при распаковке?

3. **Зафиксировать в ARCHITECTURE.md:** 
   - Что мы используем и откуда
   - Прямые ссылки на их официальные docs
   - Наши решения на базе их гарантий
   - Как мы проверяем актуальность

4. **На будущее:** отслеживать изменения в их документации/releases и обновлять наши пайплайны

---

## 0a. Компоненты и их гарантии (документация по официальным источникам)

> Эта секция — справка для разработчиков, как понимать границы и возможности каждой
> используемой библиотеки. Основана на официальных документах и исходном коде компонентов.
> Обновляется при обновлении версий компонентов (см. package.json).
>
> **Процесс обновления:** Когда версия компонента в package.json меняется:
> 1. Найти GitHub-репозиторий по ссылке `repository` в package.json компонента.
> 2. Прочитать README и официальные docs.
> 3. Обновить версию, ссылки на релизы и гарантии в этой секции.
> 4. Если поведение радикально изменилось, переписать пункт полностью.

### Компонент: draco3dgltf (v1.5.7)

**GitHub:** https://github.com/google/draco/tree/gltf_2_draco_extension  
**Версия в проекте:** 1.5.7  
**Документация:** https://github.com/google/draco (главный репо), глава glTF  
**Как используем в проекте:** `@gltf-transform/functions → fns.draco()` для сжатия геометрии (advanced feature: `--draco`).  
**Издатель:** Google Draco Team

**Ключевые гарантии / поведение:**

- **Квантизация вершин:** Draco сжимает координаты вершин путём квантизации (приведения к целочисленной сетке). Это НЕ меняет само количество вершин в нормальном случае, но может изменить количество *треугольников* косвенно:
  - При распаковке Draco некоторые вырожденные треугольники (с совпадающими вершинами после квантизации) *могут* не быть явно удалены из индексного буфера, зависит от конфигурации кодировщика. Однако в glTF-Transform стандартное кодирование с параметрами по умолчанию этого обычно не делает.
  - **Важное уточнение:** Само Draco НЕ меняет количество треугольников; если расхождение наблюдается, это результат других правил pipeline (например `weld` порождает вырожденные, которые затем детектируются отдельно).

- **Анимация и скины:** Draco сжимает только геометрию (позиции, нормали, теккоорды). Анимация, скины, morph targets кодируются отдельно и остаются нетронуты.

- **Лосси-ность:** Draco по умолчанию компрессивен с потерей (lossy), но потеря контролируется квантизацией позиций. При стандартных настройках (11 бит для позиций) потеря минимальна и в большинстве случаев визуально незаметна.

- **Обратимость:** Draco можно снять (распаковать) обратно в стандартную геометрию. Это происходит автоматически при загрузке глтф с расширением `KHR_draco_mesh_compression`. Переупаковка Draco в Draco (re-encoding) **накапливает потери** и не рекомендуется (ARCHITECTURE.md §6).

**Для нашей валидации (baseline metrics):**

- Может изменить геометрию: **Нет**, Draco сохраняет количество и топологию треугольников. Любое изменение — результат других правил.
- Может изменить структуру mesh: **Нет**, примитивы и аксессоры остаются.
- Потеря данных: **Minor** (точность позиций / нормалей, но визуально незаметно при стандартных параметрах).
- Гарантия: количество вершин, индексов, примитивов, сценография, анимация, скины — неизменны.

**Источники:**
- https://github.com/google/draco/blob/1.5.7/README.md
- Интеграция в glTF-Transform: https://gltf-transform.dev/functions#draco

---

### Компонент: @gltf-transform/core (v4.4.1)

**GitHub:** https://github.com/donmccurdy/glTF-Transform  
**Версия в проекте:** 4.4.1  
**Документация:** https://gltf-transform.dev/  
**API Reference:** https://gltf-transform.dev/classes/Document  
**Как используем в проекте:** Главный SDK. Все операции идут через `Document` (in-memory граф glTF), загрузка через `NodeIO`, трансформации через `document.transform(fn)`.  
**Издатель:** Don McCurdy

**Ключевые гарантии / поведение:**

- **Парсинг и сохранение:** Полная поддержка glTF 2.0 и расширений (KHR_* и EXT_*). Автоматически разрешает внешние буферы/текстуры и выходит как единый GLB.

- **Трансформации (Functions):** Каждая функция из `@gltf-transform/functions` гарантирует конкретное поведение:
  - `dedup()` — склеивает идентичные текстуры и материалы (структурно безопасно, не меняет вид).
  - `prune()` — удаляет неиспользуемые ресурсы (безопасно для рендера, но может менять индексы аксессоров).
  - `weld()` — объединяет вершины на epsilon-расстоянии (numeric, может порождать вырожденные треугольники).
  - `meshopt()` — вызывает кодер Meshopt (numeric, не меняет топологию).
  - `draco()` — вызывает кодер Draco (numeric, не меняет топологию).
  - `ktx2()` — кодирует текстуры в KTX2 (perceptual, контролируется параметром качества).

- **Working copy model:** Все трансформации происходят на копии Document в памяти. Исходный файл никогда не меняется.

- **Inspect (метрики):** Функция `inspect(doc)` возвращает структурированную информацию о модели (треугольники, draw calls, размеры текстур на диске и VRAM).

**Для нашей валидации:**

- Каждая функция в `@gltf-transform/functions` задокументирована с точными семантиками.
- Гарантия: если `meta.fixSafety` правила правильно указан, трансформация будет в своём слое (provable не ломает семантику, numeric/perceptual не гарантирует бит-идентичность).

**Источники:**
- https://gltf-transform.dev/functions
- https://gltf-transform.dev/classes/Document

---

### Компонент: @gltf-transform/extensions (v4.4.1)

**GitHub:** https://github.com/donmccurdy/glTF-Transform (тот же репо)  
**Версия в проекте:** 4.4.1  
**Документация:** https://gltf-transform.dev/extensions  
**Как используем в проекте:** Регистрация расширений при инициализации `NodeIO`, включая `KTX2Extension` для кодирования/декодирования KTX2 текстур.  
**Издатель:** Don McCurdy

**Ключевые гарантии / поведение:**

- **KTX2 (через EXT_texture_webp и KHR_texture_basisu):** Текстуры кодируются в контейнер KTX2 с алгоритмом BASIS-U (ETC1S для цвета, UASTC для деталей). Потеря качества зависит от параметра:
  - **ETC1S** (по умолчанию для цветовых текстур): лёгкое (на диске и в VRAM), но видимое размытие для нормалей и высокочастотных деталей.
  - **UASTC** (по умолчанию для data-текстур, опционально для всех): выше качество, но больший размер в VRAM.
  - Потеря при распаковке в браузере: минимальна при качестве ≥7 (из 8).

- **Другие расширения:** Полная поддержка KHR_lights_punctual, KHR_animation_pointer, KHR_materials_* и многих других.

- **Обратимость KTX2:** Текстуры можно снять обратно в PNG/WebP (правило `decompress-ktx2`), но с потерей качества от BASIS-U сжатия.

**Для нашей валидации:**

- KTX2 меняет размер на диске и в VRAM, но не меняет количество текстур или их назначение.
- Потеря данных: **Minor** при UASTC ≥7, **Significant** при ETC1S для высокочастотных текстур.

**Источники:**
- https://gltf-transform.dev/extensions#khrtexturebasisu
- https://github.com/donmccurdy/glTF-Transform/tree/main/packages/extensions

---

### Компонент: @gltf-transform/functions (v4.4.1)

**GitHub:** https://github.com/donmccurdy/glTF-Transform (тот же репо)  
**Версия в проекте:** 4.4.1  
**Документация:** https://gltf-transform.dev/functions  
**Как используем в проекте:** Высокоуровневые функции трансформации: `dedup()`, `prune()`, `weld()`, `meshopt()`, `draco()`, `ktx2()`, `simplify()` и др. Вызываются через `document.transform(fn)` или напрямую.  
**Издатель:** Don McCurdy

**Ключевые функции и их гарантии:**

Каждая функция в пакете задокументирована на https://gltf-transform.dev/functions с точными параметрами и побочными эффектами. Главные для нас:

| Функция | Гарантия | Потеря | Примечание |
|---------|---------|--------|-----------|
| `dedup()` | Структурно безопасна, склеивает дубли | None | provable |
| `prune()` | Удаляет неиспользуемые ресурсы | None | provable |
| `weld(tolerance)` | Объединяет близкие вершины | Numeric (зависит от допуска) | numeric, может порождать вырожденные |
| `meshopt()` | Сжимает индексы/вершины | Minor (перестановка) | numeric |
| `draco()` | Сжимает геометрию Draco | Minor (квантизация) | numeric |
| `ktx2(…quality)` | Кодирует текстуры KTX2 | Minor/Significant (от качества) | perceptual |
| `simplify()` | Упрощает геометрию (LOD) | Significant (удаляет полигоны) | lossy |

**Источники:**
- https://gltf-transform.dev/functions

---

### Компонент: gltf-validator (v2.0.0-dev.3.10)

**GitHub:** https://github.com/KhronosGroup/glTF-Validator  
**Версия в проекте:** 2.0.0-dev.3.10 (dev версия, в production используется стабильная)  
**Документация:** https://github.com/KhronosGroup/glTF-Validator/blob/main/README.md  
**API:** https://github.com/KhronosGroup/glTF-Validator/blob/main/README.md#api  
**Как используем в проекте:** Валидация входного и выходного GLB через `validator.validateBytes()`. Результат использует в отчёт фазы 4 (ВАЛИДАЦИЯ).  
**Издатель:** The Khronos Group Inc.

**Ключевые гарантии / поведение:**

- **Что проверяет:**
  1. **IoError** — ошибки ввода/вывода (например поломанный файл).
  2. **SchemaError** — нарушение JSON-схемы glTF (неверные типы, отсутствующие обязательные поля).
  3. **SemanticError** — нарушение семантики (например неверная матрица узла, несовместимые атрибуты).
  4. **LinkError** — нарушения ссылок между ресурсами (например аксессор вылезает за пределы буфера).
  5. **DataError** — нарушения в данных (например отрицательные значения в индексах анимации, деgenerate треугольники).

- **Уровни серьёзности:**
  - **Error** — блокирует спецификацию, файл невозможно корректно загрузить.
  - **Warning** — потенциальная проблема, может вызвать проблемы в некоторых движках.
  - **Information** — совет для оптимизации или совместимости, не является ошибкой.

- **Блокирующие ошибки:** Файл не будет записан, если после применения правил остаются ошибки (Error-уровня), которые добавила сама оптимизация (входные ошибки логируются как информация).

- **Особенность:** Валидатор — версия, скомпилированная из Dart в JavaScript. Полностью соответствует официальной спецификации Khronos.

**Для нашей валидации:**

- Гарантия: ошибки Error-уровня означают нарушение спецификации (запись блокируется).
- Warning / Information — логируются в отчёт, но не блокируют запись.
- Деgenerate треугольники — **Information**, не блокируют (общей совет).

**Источники:**
- https://github.com/KhronosGroup/glTF-Validator
- Исходный репо с полным списком ошибок: https://github.com/KhronosGroup/glTF-Validator/blob/main/ISSUES.md (скопирован в node_modules)

---

### Компонент: meshoptimizer (v0.22.0)

**GitHub:** https://github.com/zeux/meshoptimizer  
**Версия в проекте:** 0.22.0  
**Документация:** https://github.com/zeux/meshoptimizer (в том числе в README для JS модуля)  
**Как используем в проекте:** Сжатие геометрии через `fns.meshopt({ encoder: MeshoptEncoder })`. Также используется для оптимизации порядка индексов перед сжатием.  
**Издатель:** Arseny Kapoulkine

**Ключевые гарантии / поведение:**

- **Что сжимает:**
  - Индексные буферы (перестановка вершин для локальности, потом LZ4-подобное сжатие).
  - Вершинные буферы (атрибуты позиции, нормали, теккоорды и др.).
  - Может применять фильтры квантизации (OCTAHEDRAL, QUATERNION, EXPONENTIAL) для дополнительного сжатия данных.

- **Что НЕ меняет:**
  - Количество треугольников / вершин / индексов (остаётся то же).
  - Структура mesh (примитивы, аксессоры, материалы).
  - Анимация, скины, morph targets (они кодируются отдельно).

- **Обратимость:** Полностью обратимо без потерь (при декодировании восстанавливается оригинальные данные в пределах точности float32).

- **Производительность:** Очень быстро (1–3 ГБ/с на современных CPU). Разложен на три этапа:
  1. **reorderMesh** — переупорядочивает индексы для локальности (опционально).
  2. **quantize** / **encodeFilter** — квантизирует данные (опционально, lossy).
  3. **encode** — сжимает в конечный формат (это уже не lossy).

- **Особенность meshopt для glTF:** Вводится расширение EXT_meshopt_compression, которое браузер может распаковать на лету.

**Для нашей валидации:**

- Может изменить геометрию: **Нет**, структура и топология неизменны.
- Может изменить структуру mesh: **Нет**, примитивы и аксессоры неизменны.
- Потеря данных: **None** (если без квантизации) / **Minor** (если с квантизацией, зависит от параметра).
- Гарантия: количество треугольников, вершин, индексов неизменно.

**Источники:**
- https://github.com/zeux/meshoptimizer/blob/master/README.md (общая архитектура)
- https://github.com/zeux/meshoptimizer/blob/master/js/README.md (JS API)
- https://github.com/KhronosGroup/glTF/blob/master/extensions/2.0/Vendor/EXT_meshopt_compression/README.md (glTF расширение)

---

### Компонент: sharp (v0.33.5)

**GitHub:** https://github.com/lovell/sharp  
**Версия в проекте:** 0.33.5  
**Документация:** https://sharp.pixelplumbing.com/  
**Как используем в проекте:** Преобразование изображений (WebP / JPEG → PNG) перед кодированием в KTX2 (toktx принимает только PNG и JPEG, но WebP обрабатываем через sharp в PNG).  
**Издатель:** Lovell Fuller

**Ключевые гарантии / поведение:**

- **Что делает:** Быстрая обработка изображений (resize, rotate, crop, format conversion, colour space correction).

- **Форматы:** Входные — JPEG, PNG, WebP, GIF, AVIF, TIFF; выходные — JPEG, PNG, WebP, GIF, AVIF, TIFF.

- **Точность:** Использует libvips, Lanczos resampling. Качество — high (сравнимо с ImageMagick).

- **Когда используется:** В нашем pipeline — только когда входная текстура WebP / JPEG, а нужно PNG для toktx:
  ```
  if (mime === 'image/webp' || mime === 'image/jpeg') {
    const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
  }
  ```

- **Потеря качества:** Минимальна при выводе PNG (без сжатия). WebP → PNG — может быть потеря цвета из-за разных colorspace, но в локальном режиме это маловероятно.

**Для нашей валидации:**

- Может изменить геометрию: **Нет**, это только обработка пикселей.
- Потеря данных: **Minor** (зависит от исходного формата; PNG → PNG → безопасно).
- Гарантия: размеры изображения, метаданные RGB/RGBA остаются.

**Источники:**
- https://sharp.pixelplumbing.com/
- https://sharp.pixelplumbing.com/api-constructor (API reference)

---

## Выводы для валидации (baseline metrics)

Из анализа выше следует:

1. **Структурные метрики НЕ меняются** при сжатии (Draco, Meshopt, KTX2):
   - Количество треугольников (при условии что не используется simplify/decimation).
   - Количество вершин, узлов, примитивов, материалов, сцен, анимаций, скинов.
   - Иерархия сцены.

2. **Меняются ТОЛЬКО** (в рамках baseline):
   - Размер на диске (fileBytes) — объект сжатия.
   - Размер в VRAM (gpuBytes) — особенно при KTX2.
   - Потенциально: количество текстур (если используется dedup / prune).

3. **Поэтому** baseline-checkpoint (BASELINE_METRICS в optimize2.mjs) содержит:
   ```
   triangles, drawCalls, skins (действующие), nodes, animations
   ```

   И НЕ содержит fileBytes / gpuBytes / textureBytes, которым разрешено меняться.

4. **Для будущих расширений** (decimation, simplify и др.): любое расширение, которое меняет BASELINE_METRICS, будет автоматически заблокировано валидацией на фазе 4 (ВАЛИДАЦИЯ).

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
  // все флаги CLI, camelCase; значения по умолчанию — как у CLI:
  codec: 'meshopt' | 'draco',        // 'meshopt'
  texMode: 'mixed' | 'uastc',        // 'mixed'
  keepParts: false, noKtx: false, stripColors: false, dryRun: false,
  outDir: 'output',                  // куда писать .glb и отчёт
  force: false,                      // true → обрабатывать, даже если output/имя.glb существует
  onProgress: (e) => {},             // см. события ниже; опционально
});
```

**События `onProgress`** (для статуса фаз в UI):
`{ type: 'phase', phase: 1..5, name: 'анализ'|'план'|'применение'|'валидация'|'отчёт' }`
и `{ type: 'rule', phase: 3, ruleId, title }` — перед применением каждого правила.

**Двухуровневая обработка (v0.0.9, внутренняя механика ядра):** фазы 1–3 идут двумя
проходами — сначала базовые правила (tier basic), затем checkpoint структурных метрик
`BASELINE_METRICS = ['triangles', 'drawCalls', 'skins', 'nodes', 'animations']`, затем
расширения (tier advanced; базовое правило с `runAfter` на включённое расширение уходит
во второй проход вместе с ним — порядок пайплайна сохраняется). Фаза 4 строго сверяет
метрики итоговых байтов с checkpoint: расхождение → `validation` получает `level:'fail'`
(строка «baseline-checkpoint…» при успехе, «структура геометрии изменилась…» при провале)
и .glb не записывается. Так любое будущее расширение валидируется автоматически.
События `onProgress` фаз 1–3 шлются один раз (на базовом проходе) — номера фаз для
потребителей остаются монотонными 1→5, формы событий не изменились.

**Результат `optimizeFile` (RunResult):**

```js
{
  status: 'ok' | 'skip' | 'fail',    // fail = валидация не прошла, .glb не записан
  file: { src, dst, written: boolean, reportPath },
  findings: [ { ruleId, category, severity, fixSafety, text } ],  // «Найдено»
  skipped:  [ { ruleId, text, reason } ],                          // «Пропущено» + причина
  applied:  [ { ruleId, fixSafety, text } ],                       // «Применено»
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
  "engineOpts": {
    "codec": "meshopt",
    "texMode": "mixed",
    "keepParts": false,
    "noKtx": false,
    "stripColors": false
  },
  "notes": [ "источник/обоснование каждого бюджета" ]
}
```

- `engineOpts` — ровно поля `opts` из §4b (camelCase), передаются в `optimizeFile` без
  преобразования.
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
- `dataLoss?: 'none' | 'minor' | 'significant'` — потеря данных при распаковке (для обратимых)
- `references?: string[]` — ссылки на официальную документацию/спеку, обосновывающие правило (в духе §0: не выдумываем правила из головы). Показываются в отчёте на уровне «технические детали» (см. §4c, progressive disclosure).

### Режимы использования (для будущего UI)

- **Оптимизация**: для целевой платформы (базовые + расширения сжатия → результат)
- **Распаковка**: обратно в стандартный формат (для других целей, игр, печати, etc.)
- **Переформатирование**: перекодирование (Meshopt → Draco, WebP → KTX2)

На v0.1.0 реализованы основные пары (Draco, KTX2). На будущее: расширить на все правила 
и добавить UI-режимы для распаковки.

**Важно:** Когда пользователь скачивает результат с невозвратными изменениями (decimation, strip-colors, etc.) → 
показывать warning: _«Применены необратимые изменения. Сохраните исходный файл перед скачиванием.»_

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

## 7. What earns the stars — and what to build first

**Challenge to the broad surface area (GUI, VS Code, desktop, scores) up front.** The
classic way open-source 3D tools die is spreading across ten surfaces before one is
excellent. The thing that earns the first thousand stars is narrow and deep: **a CLI that
runs on a real asset and produces a report so insightful the developer says "I didn't
know that was in my model," plus autofix they *trust* because it has never once corrupted
an asset.** Trust is the moat. Everything else (GUI, VS Code, Action) is the *same core*
behind a different surface and can wait.

**Surface shape, when surfaces come: desktop-first, web-second, CLI-third** (from research
notes; product-owner steer). Batch work on large local assets — file-system access, GPU,
drag-drop folders, predictable heavy processing — pulls toward a local desktop app
(Tauri/Electron + Node/Rust), the shape of VNTANA's optimizer. The web is a *review portal*
(share, remote review, light inspection), not the heavy-processing core (RapidPipeline is
the cloud counter-example; Khronos' web viewer shows web *viewing* is mature). The CLI stays
the third pillar for CI/automation. Nuance vs `ROADMAP.md` §4c: a *thin* drag-drop wrapper
over the engine is cheap and worth doing early (it's what makes the tool legible to artists
and fuels the devlog); the *full* batch-review workspace with synced dual viewports and heat
maps is the Phase-4 surface, built only after the engine is trusted.

Recommended sequencing, each stage fully functional:

- **Phase 0 — Skeleton.** Monorepo, `core` interfaces, Context, a no-op engine, one
  reporter (markdown), one profile (web). Runs, finds nothing, reports nothing. Green CI.
- **Phase 1 — Analyze-only, no fixing.** Port the prototype's detectors as read-only
  rules (orphan verts, degenerate tris, dup textures/materials, unused UV, constant
  vertex colors, missing KTX2, oversized textures). Output the "Problems found /
  Skipped-with-reason" report. **This alone is already useful** and shippable.
- **Phase 2 — Safe autofix + validation.** Add `provable`/`numeric` fixes via the
  transforms adapter, the DAG scheduler, invariants + gltf-validator. This is the
  reputation-defining phase — the golden-asset test corpus (§8) must land here.
- **Phase 3 — Profiles, scoring, CI.** Device profiles, penalty-based scores, JSON +
  SARIF reporters, GitHub Action, baseline/regression diff.
- **Phase 4 — Surfaces & ecosystem.** HTML report, VS Code extension, plugin docs,
  engine-specific rule packs (Three.js, Babylon, Shopify) as external packages.
- **Phase 5 — Perceptual validation.** Headless render + SSIM to unlock `perceptual`-tier
  autofix with proof. The hardest and most differentiating subsystem, built once trust exists.

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
