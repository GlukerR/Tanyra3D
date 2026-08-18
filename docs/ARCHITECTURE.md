# Tanyra3D — Architecture & Design

> An intelligent analysis and optimization *orchestrator* for glTF/GLB assets — "ESLint +
> Lighthouse for 3D". It does **not** re-implement glTF-Transform / meshoptimizer / toktx.
> It decides *which* of their transforms to apply, *proves* each is safe, *validates* the
> result, and *explains* every decision.
>
> **How to read this document.** It is layered by date, not rewritten each time: §1–§3 and
> §5–§12 are the original design review, §4b–§4f are contracts fixed later and marked with
> their dates. Where the two disagree, the dated section wins. The project was called
> `gltf-audit` during the design review; the name survives nowhere in this document, and §11
> records the decisions that were open at that point with how each was resolved.

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
tanyra3d/
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
└─ tanyra3d.config.ts          # example user config
```

Core has **zero** dependency on any specific rule, reporter, or profile — they are
discovered via config. Core depends only on glTF-Transform's `Document` type and the
interfaces below.

> **Layout status (2026-07-24):** this monorepo structure is the TARGET shape for the first
> external plugin, not the current state. The repository is FLAT today (`optimize2.mjs`,
> `core/`, `addons/gltf/`, `assistant.mjs`, `server.mjs`, `ui/`, `profiles/`). Moving to
> `packages/*` is a deliberate event, triggered by the first external package or plugin —
> not a tidy-up done before then (same principle as EXTENDING §4: don't pay for structure
> ahead of demand).

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

## 4b. The public core API CONTRACT (fixed 2026-07-18, for v0.1.0)

> This section is the agreement between the layers (core engine · assistant · web interface).
> The core engine implements part B; the assistant and web interface depend ONLY on what is
> written here and never reach into the internals of `optimize2.mjs`. Breaking the contract
> is an explicit decision that edits this section — never a side effect of a refactor.

### A. The API as it actually was (v0.0.6) — CLI and files only

> Historical: this describes the shape before part B was implemented. The console output
> quoted below was Russian at the time and is English today (see the sample run in the
> README); the section is kept because the file layout and the metric shapes it records are
> still current.

`optimize2.mjs` exported nothing. All input and output went through the filesystem:

- **Run:** `node optimize2.mjs [draco] [--keep-parts] [--no-ktx] [--uastc] [--dry-run] [--strip-vertex-colors]`
- **Input:** `input/*.glb|*.gltf` (fixed folder). Sources are never modified.
- **Output:** `output/name.glb` (only if ≥1 fix was applied AND validation passed; never in
  dry-run), a report `output/name.report.md` (in dry-run: `name.dryrun.report.md`) with the
  sections "Found → Skipped (and why) → Applied → Validation → Estimated improvements",
  and a full log `logs/run_*.log` (rotated after 30 days).
- **Console markers:** working / done / dry-run / skipped / error, plus a closing summary
  line "done N, skipped M, errors K". An existing `output/name.glb` means the file is
  skipped.
- **Internal structures** (not exported, but stable in meaning):
  `metrics` = `{ fileBytes, drawCalls, triangles, textureBytes, gpuBytes, meshes, materials,
  textures, nodes, scenes, animations, skins, bounds }` (triangles and draw calls counted
  over scene nodes, skins only the ones actually in use); `report` =
  `{ found[], skipped[], applied[], validation[] }` — arrays of finished strings;
  `RULES[i].meta` = `{ id, category, title, severity, fixSafety, runAfter, touches, enabled }`.

### B. The target programmatic contract for v0.1.0 (implemented by the core)

`optimize2.mjs` becomes a module with exports; the CLI is a thin wrapper over them (the CLI
behaviour from part A is preserved byte for byte).

```js
import { optimizeFile, listRules, VERSION } from './optimize2.mjs';

const result = await optimizeFile(srcPath, {
  // THE POINT: everything is opt-in. An empty object `{}` is a passthrough — the file is
  // read, validated and written back without a single optimization. Optimizations are
  // enabled by name through advancedFeatures.
  advancedFeatures: [],              // [] by default. Values:
                                     //   'safe'          — lossless cleanup (dedup, prune, weld, degenerates)
                                     //   'meshopt' | 'draco' — geometry compression (codec choice)
                                     //   'join'          — flatten + merge meshes
                                     //   'instance'      — GPU instancing (threshold: 2 nodes per mesh)
                                     //   'resample'      — thin out animation keyframes
                                     //   'ktx2'          — textures to KTX2/UASTC
                                     //   'strip-colors'  — remove every COLOR_n

  // The remaining flags refine the enabled features, camelCase (matching the CLI):
  codec: 'meshopt' | 'draco',        // 'meshopt' by default
  texMode: 'mixed' | 'uastc',        // 'uastc' by default — the safest for a beginner;
                                     // 'mixed' (ETC1S for colour, UASTC for data) must be asked for
  webpQuality: 90,                   // 0…100, a SHARE of the source texture's own quality,
                                     // not an absolute encoder setting. 90 is the default
                                     // and the position the UI marks as recommended; 100
                                     // means "as in the source" — lossless input stays
                                     // lossless and JPEG keeps the quality read from its own
                                     // quantisation table. There is no value above 100:
                                     // quality destroyed by the first codec cannot come back.
                                     // Out-of-range and non-numeric values fall back to 90.
                                     // Textures that are ALREADY WebP are never re-encoded,
                                     // at any slider position — that is a rule about format,
                                     // not about quality (measured: WebP→WebP costs +6% even
                                     // when aimed exactly at the source's own ceiling).
  keepParts: false,                  // don't merge parts even under 'join'
  noKtx: true,                       // KTX2 stays off until advancedFeatures contains 'ktx2'
  stripColors: false, dryRun: false,
  outDir: 'output',                  // where the .glb and the report are written
  force: false,                      // true → process even if output/name.glb already exists
  onProgress: (e) => {},             // see the events below; optional
  locale: 'en',                      // language of rule messages
  log: (line) => {},                 // line-by-line pipeline trace; optional
});
```

**Legacy path.** The boolean fields `safe`, `join`, `instance`, `resample`, `compress` are
also accepted directly — `{ safe: true }` behaves exactly like `advancedFeatures: ['safe']`.
This is a leftover from the pre-opt-in version; new integrations should use
`advancedFeatures`, which is the only field that describes everything enabled as one list.

**Re-optimization is a first-class core operation.** `optimizeFile(srcPath, opts)` is a
**pure function of (source, options)**: the source file is never mutated (the result goes to
`outDir`, which differs from the source — §4d) and no state carries between calls. The same
model can therefore be run any number of times with different `opts` / `advancedFeatures`,
producing independent variants — a property of the core, shared by every format and add-on
(the engine knows nothing about the format — §4a). Optimization ALWAYS starts from the
source, never on top of a previous result — it is not cumulative. The presentation layer
(web/UI) is free to cache the source so that dozens of iterations don't re-upload the file,
but the guarantee of re-optimizability lives here, in the core contract.

**`onProgress` events** (for phase status in the UI):
`{ type: 'phase', phase: 1..5, name: 'analysis'|'plan'|'apply'|'validation'|'report' }`
and `{ type: 'rule', phase: 3, ruleId, title }` — emitted before each rule is applied.

**Two-tier processing (v0.0.9, internal core mechanics):** phases 1–3 run in two passes —
first the basic rules (tier basic), then a checkpoint of the structural metrics
`BASELINE_METRICS = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations',
'morphTargets', 'attributes']` (`vertices` is a soft key: ℹ without blocking, see §5), then
the extensions (tier advanced; a basic rule with a `runAfter` on an enabled extension moves
into the second pass along with it, so the pipeline order is preserved). Phase 4 compares
the metrics of the final bytes against the checkpoint strictly: any divergence gives
`validation` an entry with `level:'fail'` ("baseline-checkpoint…" on success, "geometry
structure changed…" on failure). Every future extension is therefore validated
automatically.

**The file is written even on failure** (Alexander's decision, 2026-07-30). Writing used to
be blocked; that turned out to take the choice away from the person — sometimes the result
is wanted even with a caveat. Now `status` becomes `'fail'`, the interface shows a red
warning listing the divergences, and the file can still be downloaded. The only thing that
still writes nothing is `dryRun`.
The `onProgress` events for phases 1–3 are sent once (on the basic pass) — phase numbers
stay monotonic 1→5 for consumers, and the event shapes are unchanged.

**The `optimizeFile` result (RunResult):**

```js
{
  status: 'ok' | 'skip' | 'fail',    // fail = validation did not pass; the .glb is STILL written
  file: { src, dst, written: boolean, reportPath },
  findings: [ { ruleId, category, severity, fixSafety, text } ],  // "Found"
  skipped:  [ { ruleId, text, reason } ],                          // "Skipped" + reason
  applied:  [ { ruleId, fixSafety, reversible, dataLoss, text } ], // "Applied" + reversibility (§4d)
  validation: [ { level: 'pass'|'info'|'fail', text } ],           // ✅/ℹ/❌
  metrics: { before: {…}, after: {…} },   // shapes from part A, raw bytes, unformatted
  error?: string,                          // on an exception (model unreadable, etc.)
}
```

`listRules()` → an array of `RULES[i].meta` (read-only) — for future settings and docs.
`VERSION` → the string from package.json.

**Stability rules:** fields may be added freely; renaming or removing a field, or changing
its meaning, is a breaking change (edit this section and warn the dependent layers).
Formatting (MB, percentages, UI language) belongs to the consumer; the core hands back
numbers in bytes and finished `text` strings as they are. Human-facing explanations layered
on top of `RunResult` belong to the assistant, not the core.

### C. Additive implementation details (2026-07-18, contract B implemented in optimize2.mjs)

These do not change contract B — they are clarifications within "fields may be added freely":

- `opts.log?: (line: string) => void` — a sink for progress lines (phase lines and rule
  steps, as printed by the CLI). Silent by default; the CLI passes `console.log`, which
  preserves the previous output. A library call without `log` prints nothing (apart from
  glTF-Transform's own logger — the `prune: Removed types…` lines).
- Engine-level findings and applications (outside `RULES`) carry stable `ruleId`s prefixed
  with `engine/`: `engine/input-compression` (removing incoming Draco/Meshopt, category
  `geometry`, fixSafety `provable`) and `engine/input-validation` (gltf-validator errors
  inherited from the input; category `scene`, severity `warn`, fixSafety `none`).
- `file.src`, `file.dst`, `file.reportPath` are absolute paths; `outDir` from opts is
  resolved against the process cwd. On `status:'skip'` and on an early `fail` (an exception
  before the report), `reportPath: null` and `metrics.before/after: null`.
- `skipped[].reason` is the reason without a leading title; for strings a rule returned as a
  single phrase, `reason === text`.
- `applied[]`, `skipped[]` and `findings[]` carry an optional `i18n` field: the "recipe" for
  that record's finished strings, `{ record field → { messageId, data } }` (for example
  `{ text: {...}, reason: {...} }`). Records assembled from the message catalog have it;
  records that arrived already finished do not. `text` and `reason` remain finished strings —
  a consumer that doesn't need translation never notices `i18n`.
  Why: `localizeResult(result, locale)` (`core/i18n.mjs`) rebuilds the same report in another
  language from a FINISHED result, following those recipes. Switching language in the
  interface is a redraw, not work: re-running processing for the sake of a translation is not
  allowed.
  A substitution inside `data` may itself be a message (`{ messageId, data }`) — that is how a
  string is assembled from pieces and translated whole rather than half.
- `optimizeFile` caches one `NodeIO` (Draco/Meshopt decoders) per process; parallel calls
  within one process are not CPU-isolated — queueing is the consumer's job.

---

## 4c. The assistant layer contract (v0.1.0)

> This section is the agreement between the assistant layer and the web interface. The
> assistant is implemented in `assistant.mjs`; the web interface depends ONLY on what is
> written here. `assistant.mjs` does **not import** `optimize2.mjs`: the web interface calls
> the core, and the assistant layer only translates `RunResult` (§4b) into human language.
> Platform profiles are DATA (`profiles/*.json`): a new platform is a new json file, with no
> change to the assistant's code. Breaking the contract means editing this section and
> warning the web interface.

### Exports of `assistant.mjs`

```js
import { listPlatforms, planFor, explainResult } from './assistant.mjs';

// The platform list for the UI dropdown (read from profiles/*.json).
listPlatforms()
// → [ { id, title, description } ]

// A processing plan for a platform: engineOpts are passed to optimizeFile AS IS.
planFor(platformId)
// → {
//     profileId,                 // profile id
//     title,                     // human name of the platform
//     engineOpts,                // exactly the opts from §4b (codec, texMode, keepParts, noKtx, stripColors)
//     explanation: [ string ],   // why these settings were chosen, without jargon
//   }

// Translating RunResult (§4b) into human language for the right-hand "Analysis" panel.
explainResult(runResult, platformId)
// → {
//     summary: string,           // 1–2 sentences: file size / video memory with numbers
//     highlights: [ string ],    // the main improvements in plain language (max 5–6)
//     budgetChecks: [ { name, limitText, actualText, ok: boolean, advice?: string } ],
//     warnings: [ string ],      // from skipped and from validation entries at info|fail
//   }
```

**Semantics and rules:**

- **Formatting belongs to the assistant.** The core returns `metrics` in bytes (§4b); the
  assistant converts to KB/MB and percentages inside its texts. The web interface never
  recomputes those texts — it displays them as issue cards, colour-coded by the `ok` field.
- **budgetChecks** compare `metrics.after` against `profile.budgets`. Only measurable metrics
  are checked: `triangles`, `drawCalls`, `vramMB` (← `gpuBytes`), `fileMB` (← `fileBytes`).
  `textureMaxSize` is not checked yet — the core doesn't expose texture dimensions in
  `metrics`. When a budget is exceeded (`ok:false`), `advice` explains what was exceeded, by
  how much, and what to do at export time.
- **A file growing while video memory drops is NOT an error.** It is explained neutrally: the
  GPU texture format is heavier in the file but takes several times less on the video card.
- **An unknown `platformId`** throws an `Error` with a clear message and the list of
  available ids.
- **Abnormal `RunResult` states** (`error` / `status:'skip'` / `metrics === null`) still
  produce a meaningful `summary` and empty arrays where there is no data.

### The `profiles/*.json` format

```json
{
  "id": "shopify",
  "engine": "threejs",
  "title": "Shopify",
  "description": "1–2 sentences for the user, without jargon",
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
  "notes": [ "source / justification for each budget" ]
}
```

- `baselineOpts` are exactly the `opts` fields from §4b (camelCase), passed to `optimizeFile`
  without transformation. This is the platform's BASELINE plan: KTX2 and Draco are not part
  of it — the user enables those through `advancedFeatures`.
- The `engineOpts` field inside a profile file is a **deprecated name**. `assistant.mjs`
  reads it as a fallback (`profile.baselineOpts || profile.engineOpts`), but new profiles
  must use `baselineOpts`. Not to be confused with the `engineOpts` field in the **response**
  of `planFor()` — that name is unchanged and there is no reason to change it.
- `budgets` are in human units: `textureMaxSize` in pixels, `vramMB`/`fileMB` in MB,
  `triangles`/`drawCalls` as counts. The assistant converts budget MB into bytes when
  comparing.
- `notes` justify each budget (sources: Khronos 3D Commerce recommendations, the platform's
  official limits, Meta's recommendations for Quest — or a conservative estimate, stated as
  such).
- `engine` names the engine this target is described for (§4g). Mandatory, and mandatory
  even while there is only one engine: the pair must be visible in the data rather than
  buried in a display title such as "Web (Three.js)". Guarded by
  `tests/engine-target-split.test.mjs`.
- **`reversible` and `dataLoss` do NOT belong in a profile.** They are properties of the
  optimization itself and live in `addons/gltf/rules.mjs`; the UI reads them from
  `result.applied`. They were duplicated here until 2026-08-09 and nothing read the copies —
  a second list of one truth drifts silently. Same guard.
- **`availableExtensions` does NOT belong in a profile either** (moved out 2026-08-09). Which
  options to offer is a property of the reader, so the list lives in `engines/<id>.json`. It
  had been sitting in all four profiles as four byte-identical copies — which is what proved
  it was never a property of the target. Same guard.
- The file goes into `profiles/`, named `<id>.json`. Nothing else needs registering.

### The `engines/*.json` format

```json
{
  "id": "threejs",
  "title": { "en": "Three.js", "ru": "Three.js" },
  "description": { "en": "1–2 sentences, no jargon", "ru": "…" },
  "viewer": "threejs",
  "availableExtensions": [
    { "id": "ktx2", "opts": { "noKtx": false } }
  ],
  "notes": [ "why this engine reads what it reads" ]
}
```

- `availableExtensions` sets only the **composition** of the list. The wording of each entry
  comes from `core/messages/` by `id` (Rule 8) — an engine file must not carry user-facing
  option text.
- `viewer` names the viewport implementation to mount. It is not decorative: the registry
  `VIEWERS` in `ui/viewer/index.js` is keyed by exactly this name, `useViewer()` refuses a
  name the app does not ship (and says so in the console instead of quietly rendering with
  the wrong engine), and `tests/engine-target-split.test.mjs` fails if any engine names a
  viewer that is not in the registry. Adding an engine is therefore a data change **plus**
  one line in that registry — which is the honest cost, not a hidden one.
- A missing engine file is not a crash: the extensions list comes out empty and the
  "Advanced options" panel does not appear. An invented list would be worse than none.
- `enabled: false` hides an engine from the UI, mirroring the same field in a profile.
- The file goes into `engines/`, named `<id>.json`. Nothing else needs registering.

---

### Progressive disclosure — levels of explanation (v0.1.0: 3 levels)

Every explanation of a decision is served in layers: by default the user sees only the top
level and expands further at will. One interface serves both the beginner and the expert
without overwhelming the first or irritating the second.

For v0.1.0 there are exactly **three levels** (visualization and spec links come later, not
at MVP):

1. **Human** (default) — what happened and why, in an artist's language. Example: "The
   textures were 4096×4096. For a mobile target that is about 64 MB of video memory. Reduced
   to 2048×2048 — 75% memory saved, no visible difference."
2. **Technical details** (expandable) — the rule name, the safety tier (§2.4), before/after
   numbers, and the `references` from the rule's metadata (§4d).
3. **Raw metrics** (expandable) — the unprocessed `RunResult` data (§4b): counters, sizes,
   timings.

Ownership: the assistant layer produces the content of all three levels in `RunResult`; the
web interface is responsible only for presentation (collapse/expand). Level 1 is always
present; levels 2–3 are optional when there is no data.

---

## 4d. The reversibility principle (foundation of a universal transformer)

v0.0.8+ lays the architecture of a **universal model transformer**, not merely an optimizer.
Every compression or conversion has an inverse operation, where one is possible.

### Kinds of reversibility

- **✅ Fully reversible** (no data loss): Draco ↔ standard format, Meshopt ↔ standard
- **⚠️ Reversible with loss** (minor): KTX2 ↔ PNG/WebP (loss comes from BASIS-U decoding and
  depends on the encoding parameters)
- **❌ Irreversible**: decimation (polygons removed), flatten/join (structure lost),
  strip-colors (data removed)

### Rule metadata

Every `rule.meta` carries:
- `reversible: boolean` — does an inverse exist?
- `reversalRuleId?: string` — id of the inverse rule, if there is one
- `reversalNote?: string` — description for the user
- `dataLoss?: 'none' | 'minor' | 'significant'` — data loss: for reversible rules, the loss
  incurred when decoding; for irreversible ones, how significant the permanently lost data is
  (`none` = only unused or identical data was removed, `significant` = structure or visible
  content was lost)
- `references?: string[]` — links to official documentation or the spec that justify the rule
  (in the spirit of the open-sources principle — see `docs/ЗАВИСИМОСТИ.md`, "dependencies":
  we don't invent rules
  out of thin air). Shown in the report at the "technical details" level (§4c, progressive
  disclosure).

### Modes of use (for the future UI)

- **Optimize**: for a target platform (basic rules + compression extensions → result)
- **Decode**: back to the standard format (for other purposes — games, printing, etc.)
- **Re-encode**: convert between codecs (Meshopt → Draco, WebP → KTX2)

The main pairs (Draco, KTX2) are implemented for v0.1.0. Later: extend to every rule and add
UI modes for decoding.

**Important:** when the user downloads a result containing irreversible changes (decimation,
strip-colors, etc.) a warning must be shown: _"Irreversible changes were applied. Keep the
source file before downloading."_

Implemented (v0.0.8): every `applied` record carries `reversible`/`dataLoss` from the rule's
meta (a lossy branch inside a rule can mark its own records separately — `res.irreversible`
in `fix()`); the UI shows a warning above the download button when anything applied has
`reversible: false` + `dataLoss: 'significant'`, listing the specific changes.

---

## 4e. The Core Engine as a single application platform (Alexander's specification, 2026-07-23)

> Recorded as a requirement, NOT as an implementation. This is the authoritative statement of
> which modules are mandatory, why they are shared across every engine and format, and how
> that fits the contracts already agreed in §4a–§4d and `EXTENDING.md`. What lands before
> 0.1.0, what is here now and what comes later is in "What this changes in priorities" below.

### Terminology: two meanings of "Core Engine"

In §4a–§4d, "core" means the format-agnostic optimization engine (`optimize2.mjs`): no UI, a
pure function `(source, options) → RunResult`. Alexander uses "Core Engine" in a BROADER
sense — as the **permanent application layer**, shared by every future viewer engine
(three.js today; Unreal, Unity and others later) and every format. Besides the optimization
engine, that layer holds the UI shell, the viewport harness, the file and texture managers,
the single Metadata and Validation modules, the logs and the export path. Both meanings are
compatible: the broad Core Engine is the narrow optimization core PLUS the shared shell.
Below, "platform layer" means the broad sense.

This is a direct continuation of `EXTENDING.md` §1 ("a small core plus everything as plugins:
importers, exporters, viewers, profiles…") and §4a (the engine knows nothing about the
format). What is new here is the explicit statement that **the application shell is also part
of the permanent layer**, not part of the three.js implementation.

### The principle (item 13 of the specification)

When the platform or engine changes, EXACTLY three things change:
1. **the viewport engine** (three.js → Unreal/Unity/…);
2. **the contents of the Metadata and Validation windows** — which data and which checks,
   depending on the format;
3. **the list of optimization options on the right** — different for each platform.

The action logic (loading, model manager, texture manager, camera control, reset,
before/after comparison, the Build button, export, logs) is **the same on any engine**. A new
engine, importer, exporter or plugin does NOT reimplement those capabilities — it connects to
the existing platform-layer modules through one API. A seam that already works this way is
the viewer contract in `createViewer()` (`ui/viewer/index.js`): clearing the canvas on reset
lives in the `ViewportSlot.reset()` harness rather than in the three.js engine, so a new
engine gets that behaviour for free.

### Mandatory platform-layer modules (13 items) and their status

| # | Module | Must provide | Status today | Owning seam / reference |
|---|---|---|---|---|
| 1 | File loading | accept any supported format (drag-and-drop + picker), UI unchanged by a new format | GLB only; UI text "Drop a .glb file" | Importer `bytes→Document` (`EXTENDING.md` §2); §4a |
| 2 | File manager | a list of ≥5 models: name, format, path, status, textures, metadata | absent (one model, `purgeSourcesExcept`) | new module; the UI already has `.outliner`/`model-list` groundwork |
| 3 | Texture manager | drag-and-drop / picker for textures, binding to a model, replace, delete; shared by all importers | absent | new module |
| 4 | Left panel (Original) | Original Mesh · File · Tris · Vertices · Draw Calls · Materials · Textures | present (`renderOriginalStats`, HUD) | platform layer; same view on any engine |
| 5 | Right panel (Optimized) | Optimized Mesh · % (+/−) · File · Tris · Vertices · Draw Calls · Materials · Textures | present (`renderComparison`, delta badge) | platform layer |
| 6 | Viewport control | rotate both at once, zoom, pan, Reset Camera, synchronization | present (`DualViewport`, linked cameras, `resetView`) | the `createViewer()` contract |
| 7 | Original/Optimized comparison | splitter, adjustable width, synchronized navigation, future unlinking | present (`viewport-split`, splitter, camera-link toggle) | platform layer |
| 8 | Metadata | ONE module; a new format only adds its own data, it does not get its own Metadata | present as a format-agnostic seam | `inspect()` add-on hook → `inspectFile()` (§4a, implemented) |
| 9 | Validation | ONE module; a new format only adds its own checks (Geometry/UV/Materials/Textures/Animations/Skeleton/Cameras/Lights/Extensions/…) | present as a seam; the check set is a subset | §2.3 (validation is centralized), §2.5 (three tiers), `inspect()` |
| 10 | Build / Optimize | the main button; the result appears in the right viewport by itself | present (`run-btn` → `loadOptimized`) | §4b `optimizeFile` |
| 11 | Download Result | ONE button → an export dialog (format/name/location); UI unchanged by a new exporter | currently two buttons (GLB + Export JSON), no dialog | Exporter `Document→bytes` (`EXTENDING.md` §2); §4d |
| 12 | Logs | every Core Engine action is logged (load, texture, import, optimization start/finish, Validation, Metadata, export, errors, warnings) | present (panel + log window, events); some events wait for their features | implemented 2026-07-23 (3) |
| 13 | Architecture | one UI + one Core; only format functionality is extended | a principle; consistent with `EXTENDING.md` §1–2, §4a | this section |

### How this fits the existing contracts (a check, no contradictions)

- **§4a (the core is format-agnostic)** directly supports items 8/9/13: Metadata and
  Validation are already built as a single seam (`inspectFile` → add-on `inspect()`), and a
  new format implements the same hook with its own data. Extending the Validation check set
  (Skeleton, Cameras, Lights…) is an addition to an existing module, not a new module per
  format.
- **§4c (profiles as data)** — "the option list on the right changes per platform" already
  works that way, though the list itself comes from the target's **engine**
  (`engines/*.json`, §4g) while the budgets come from the target (`profiles/*.json`). A new
  platform is a new json; a new engine is a new json plus one line in the `VIEWERS` registry.
  No extra architecture is needed.
- **§4d (reversibility, exporters)** — item 11 (Download Result) sits on the Exporter seam:
  one dialog, formats added as exporter plugins without touching the UI. An environment
  caveat: choosing an ARBITRARY save location in a browser is restricted (it needs the File
  System Access API, Chromium only); the honest minimum is choosing the format and the name,
  with the location being the standard downloads folder. A full "Save As" belongs to a
  desktop shell, or to the Chromium-only API as a progressive enhancement.
- **`EXTENDING.md` §2 (typed extension points)** — items 1/11 (format import/export) already
  have contracts (`bytes→Document`, `Document→bytes`); non-glTF export (FBX, USDZ) remains a
  wall (closed Autodesk/Apple SDKs), regardless of how ready the UI dialog is.

### What this changes in priorities (briefly)

The specification introduces no new architectural principles — it makes explicit that the
application shell belongs to the permanent layer, and it provides a checklist of mandatory
modules. Some of it is already implemented and is merely being formalized as "the Core Engine
shared across engines" (items 4–10, 12); some is cheap UI work available now (the upload
text, merging export into one button plus a dialog); some is new subsystems for later (a
model manager for ≥5 models, a texture manager, non-glTF import/export).

---

## 4f. Two planes: Inspect and Processing (glTF is the workbench, not a universal model) (2026-07-24)

> Recorded after an architecture session with Alexander. It clarifies §4a: "the core works on
> a glTF-Transform `Document`" could previously be read as "every asset MUST become glTF".
> That is NOT the case.

**In plain words.** glTF is a workbench in the workshop, not a passport every asset is
required to obtain. When you are simply LOOKING at a model, you look at it in its native
format — no workbench needed. When you DO something to a model (compress, optimize, display),
you put it on the bench, work, and take the result away. There is one bench for everyone, but
the model does not become the bench forever.

### The two planes

1. **The Inspect plane ("look at it").** Native providers per format (glTF; later FBX, USD,
   OBJ…). The format is read AS IS, with no forced conversion to glTF. Purpose: metadata,
   platform budgets, compatibility checks. USD, FBX and anything that does not fit the shape
   of glTF lives HERE, natively.

2. **The Processing plane ("work on it").** A glTF-based pipeline (glTF-Transform,
   meshoptimizer, KTX tools). Conversion to glTF is an intermediate build step, and ONLY
   where operations that depend on the glTF ecosystem are needed (geometry compression, KTX2
   and so on).

**The boundary in one sentence:** glTF is needed where you DO or DRAW (optimization,
rendering). It is not needed where you only LOOK (metadata, budgets).

### Why a glTF hub is mandatory on the Processing plane (not "one option among several")

The project decided (§1) NEVER to rewrite optimization engines — only to call existing ones
(glTF-Transform / meshopt / toktx). Those engines are glTF-native. So you cannot have both
"no mandatory hub" AND "we reuse proven engines": a meshopt rule physically cannot run on an
FBX model. The hub on the Processing plane is a direct CONSEQUENCE of the decision not to
rewrite engines. Abandoning those engines in favour of "native optimization for every format"
means twelve half-working optimizers — the failure mode of spreading thin.

### Providers

A format provider's job is to load an asset, supply data for inspection and — where possible —
write a correct export. But READING foreign formats is easy; WRITING back to non-glTF (FBX,
USDZ) is a wall (closed Autodesk/Apple SDKs). Calling something a "provider" does not remove
that wall. So providers are, at first, mostly about READING and inspection, not writing.

**Source assets are never mutated** (confirming §4d and §6): we work on a copy, the source is
untouchable.

### Viewport = Preview Representation

The viewport is a consumer of `RunResult` (§4b), not a pipeline stage and not a native
renderer for every format. It shows a form CONVENIENT for display (a Preview Representation)
rather than rendering USD, FBX and the rest each in its own way. That removes the cost of
teaching the viewport to draw every format.

### How to think about the decomposition (instead of "six layers in a column")

Three orthogonal things, not one stack of layers:
- **Pipeline (stages):** load → analyze → plan → apply → validate → report (§5).
- **Extension points (plugins):** Importer / Exporter / Rule / Profile / Reporter / Viewer
  (EXTENDING §2).
- **Surfaces (contract consumers):** Web (Tanyra3D) / CLI / Desktop / CI.

And two INDEPENDENT axes: the **format axis** (what we read and write) ≠ the **target axis**
(what environment we prepare for). A model can be FBX on input and Shopify as the target:
format and target are unrelated.

### What this does NOT change

The MVP remains GLB/Web. Everything above is the shape of a future extension, not a rework of
what exists. On the web, glTF is both the workbench and the target format — the two planes
coincide, so TODAY the separation is invisible. It matters once non-glTF input formats arrive
(0.3.x and beyond).

---

## 4g. Engine and target are two different axes (Alexander's decision, 2026-08-09)

**Status: built (2026-08-10), minus the catalog screen.** The engine is a table of its own
(`engines/*.json`), the API has `/api/engines`, the inspector has two symmetric fields, and
the viewport is chosen by name through a registry. What is deliberately *not* built: a second
engine, and the catalog screen. Adding an engine is now one json file plus one line in the
`VIEWERS` registry — no changes to `app.js`, `assistant.mjs`, `server.mjs` or any profile.

### The problem

A profile such as `threejs.json` is titled "Web (Three.js)" — a target and an engine welded
into one name. That works while there is exactly one engine and breaks the moment there are
two: Three.js runs on a website, on a phone, inside Shopify and inside a Quest browser, and
each of those targets can also be driven by a different engine.

Looking at the actual files, one profile carries **three different kinds of fact**:

| Field | Actually belongs to | Why |
|---|---|---|
| `budgets` (+ their sources in `notes`) | **the target** | Shopify's own size thresholds are Shopify's, whatever renders the model |
| `availableExtensions` — what to offer | **the engine** | whether KTX2 opens without a decoder is a property of the reader |
| `reversible`, `dataLoss` | **the optimization itself** | `join` is irreversible and loses structure always, everywhere |

The third row was already duplicated: the same facts live in `addons/gltf/rules.mjs`. They
agreed, but this is precisely the shape that already went wrong once with
`EXCLUSIVE_FEATURES` / `EXCLUSIVE_GROUPS` (see the note at `addons/gltf/index.mjs`): two
independent lists of one truth, drifting silently.

### The decision — three tables, not two

1. **Rule** (already in code, `addons/gltf/rules.mjs`) — what an optimization does, whether
   it is reversible, what it costs. Independent of both engine and target. **Single source.**
2. **Engine** (`engines/<id>.json`, **built 2026-08-10**) — what this engine offers out of
   the box and **which viewer module to mount**. This is where "a different engine means a
   different viewport" lives; the `viewer` field is wired to the `VIEWERS` registry in
   `ui/viewer/index.js`, so the sentence is executable rather than aspirational.
3. **Target** (`profiles/<id>.json`, existing) — budgets with sources, caveats, and the
   `engine` it is described for.

A **profile then stops being the target file and becomes a saved pair**: target + engine +
local tweaks. That is exactly the object a user creates for their own pipeline, so
user-defined profiles need no separate mechanism.

### What the target may do to the engine's list (Alexander's decision, 2026-08-10)

The engine declares what it can read. **A target may subtract from that list; it may never
define it.** If the target defined the list we would be straight back to four byte-identical
copies. "model-viewer can read Meshopt" is true on every site — an engine fact. "This
storefront never wired up the decoder" is a fact about one deployment — a target fact.

Subtraction is `"excludeExtensions": ["meshopt"]` in the profile, and the option then
**disappears entirely** — not greyed out, not annotated.

This looks like a contradiction of the "shown, not hidden" rule below. It is not: that rule
governs the **selector fields**, where the user arrives looking for a name they already know
and, not finding it, goes searching outside the program. The options list is the opposite
situation — the user has no prior expectation of what should be there, so there is no
expectation to betray. A Shopify target with four working buttons is easier than fourteen
buttons where ten are greyed. We do not list the world's decoders that Three.js cannot read
either; the list has always meant "what works here", and a target is the same principle one
level down. The full palette of an engine stays reachable by choosing that engine without a
target.

### "No target" is a choice of its own (Alexander's decision, 2026-08-10)

The target list leads with a dash — **no platform** — and that is the default. Pick an engine,
leave the platform blank, and you see everything that engine can do, with no budgets at all:
nobody is entitled to make demands when no target has been named. It is implemented as a
synthetic profile (`assistant.mjs`, `syntheticProfile()`), so `planFor`, `explainResult` and
`extensionsOf` receive an ordinary profile — one without budgets or a name — and needed no
special cases.

Two consequences worth stating:

- **`planFor(platformId, lang, engineId)` takes an engine.** Without a target there is nowhere
  else to get one; this is the point at which the two axes became genuinely independent. With
  a target chosen, the passed engine is ignored — a pair that does not exist must not be
  costed. The parameter is additive, so §4c's stability rules hold.
- **The default had to move.** With Shopify enabled and the list sorted, the first real
  platform would have been selected on startup, and the app would silently have claimed a
  target the user never picked — along with its budgets. The dash claims
  nothing. For the same reason the leading engine is named in data (`"primary": true`) rather
  than left to alphabetical order, which would have put `model-viewer` ahead of `threejs`.

This also removed the last naming wart. `profiles/threejs.json` was titled "Web (Three.js)" —
a target named after an engine — and it is now gone as a platform: **"plain web" and "no
target" are the same thing**, and keeping them apart asked the user about a distinction that
does not exist. Its Khronos numbers live on in `profiles/_none.json`, the figures the dash
shows. The leading underscore plus `enabled: false` keep it out of the platform list, and it
deliberately carries no `engine` field — the dash suits any engine, and the engine comes from
the user's own choice. It may never grow a `limit`: red means "this platform will not accept
the file", and there is no platform.

**Choosing either field fixes the other.** Picking Shopify switches the engine to
`model-viewer`; switching the engine drops a target that does not run on it back to the dash,
because the pair "Shopify + Three.js" does not exist and must not sit on screen as if it did.
The target list is not shortened — Shopify stays visible with its reason, and picking it
brings its engine along.

### Corrections found while building this (2026-08-10)

- **Shopify's 15 MB was recorded as a hard limit. It is not.** Their own page says
  "File size: Up to 500 MB" — that is the refusal — and "If you upload a 3D model file that
  exceeds 15 MB, then your file is automatically optimized". Over 15 MB the file is accepted
  and **silently rewritten**. For an optimizer that is the more consequential number: past it,
  our work is thrown away and replaced by theirs. So `warn: 15`, `limit: 500`.
- **Two levels are not enough here.** Shopify really has three: "about 4 MB" is their advice,
  15 MB is "we will rewrite you", 500 MB is "we will not take it". `warn`/`limit` can express
  two, and the middle one wins because it is the one with a consequence the user can act on.
  The 4 MB figure survives only in the profile's note. Worth revisiting if a second platform
  turns out to have the same shape.
- **The engine field looked wrong because the CSS was bound to `#platform-select`.** The style
  belonged to the pattern, not to one field, so the newly added engine select rendered as a
  bare system control. Now on `.select-wrap select`; the next such field gets the look for
  free.

### Soft advice and hard refusal must not look alike

Both live in the same budget entry — `warn` and `limit` — and they already render differently
(`ui/style.css`: `.budget-row.warn` → `--warning`, `.budget-row.over` → `--error`). That is
what makes it acceptable to keep advisory numbers at all: 100 000 triangles from the Khronos
asset auditor is guidance, and nothing breaks at 100 001, so it is yellow. Shopify's 15 MB is
a real refusal, so it is red. Guarded by `tests/engine-target-split.test.mjs`.

Not yet built, recorded so it is not lost: when a target declares a hard limit and the result
exceeds it, the export dialog should say so in red — **without blocking the download**. The
mechanism already exists for a different case (`export.integrity.*`: the file is complete, it
saves as is, the decision is the user's), and a hard-limit warning belongs in the same place
and behaves the same way. Refusing to hand over a file the user asked for would be the one
unacceptable outcome.

### The UI rule: two fields that filter each other, never a hierarchy

The hard question was: a person is looking at an engine, but the target they want belongs to
a different one — and they should not have to know that in advance, or go looking outside the
program for the answer.

So the two fields are **symmetric**. Picking a target reorders the engine list; picking an
engine reorders the target list. Neither is a dead end and the order of choice does not
matter.

**Incompatible combinations are shown, not hidden**, each with its reason on the spot:
"Shopify reads only what model-viewer reads — Draco will not open here." A greyed-out entry
with no explanation sends the person to search the internet; a sentence next to it answers
them where the question arose. This is §2.4 and the "nothing happens silently" principle
applied to the act of choosing.

### The catalog screen — deferred on purpose

A separate table of ready pairs (target | engine | key limits), where a row selects both
fields at once and user profiles sit alongside the built-in ones, is the right shape. It is
**not** being built now: there is one engine and three of the four targets are disabled, so
the table would have a single live row and we would be designing against emptiness. It gets
built when the second engine arrives.

### What was done immediately (so the change stays cheap)

- Every profile now carries an explicit `"engine": "threejs"`. The field is redundant with a
  single engine — that is the point: the pair becomes visible **in the data** instead of
  hiding inside a display title.
- `reversible` / `dataLoss` were **removed from the profiles**. Nothing read them: the UI
  takes both from `result.applied`, and the tests from `listRules()`. Duplicated dead data is
  how the next divergence starts. The old guard in `tests/engine-contract.test.mjs` demanded
  the opposite — that profiles carry these fields (finding Н-5: the UI must be able to warn
  about irreversibility *at the checkbox*, before the run). The requirement stands; only its
  guard changed. It now checks the fact is **reachable** — every offered extension has a rule
  and that rule states the cost — instead of checking a copy exists.

### What was built next (2026-08-10)

- **`engines/threejs.json`** — the engine's own table. `availableExtensions` moved here out of
  all four profiles, where it had been sitting as four byte-identical copies.
- **`assistant.mjs`** — `listEngines()`, `enginesForPlatform()`, `platformsForEngine()`. The
  last two exist for the symmetry rule below: each field can ask what the other allows, so
  neither is the parent of the other. `planFor()` returns `engineInfo` (name + viewer).
  `listPlatforms()` entries now carry `engine`, so the UI can pair the two fields without one
  request per platform.
- **`GET /api/engines`**, optionally `?platform=`. A separate endpoint rather than a field
  inside `/api/platforms`: an engine exists whether or not a target uses it, and vice versa.
- **The inspector has two fields.** With one engine the engine field is *locked, not hidden*,
  and its tooltip says why — a greyed control with no explanation reads as a defect. A target
  belonging to another engine stays in the list with the reason in its own row
  (`insp.platform.otherEngine`), never removed and never greyed out.
- **The viewport is chosen by name.** `createViewer()` was already a seam; it is now a lookup
  in `VIEWERS`. `useViewer()` refuses an unknown name loudly and keeps the current one —
  rendering a model with the wrong engine and calling it a preview is the worst available
  outcome, given the preview is the whole point of the app.
- **Known limit, recorded not forgotten:** switching engines re-mounts on the *next* viewport
  creation, so an already-loaded model keeps the old implementation until reset. With one
  implementation this cannot occur; the second one will need the slots recreated.

### Known inaccuracies (closed 2026-08-18 — kept as a record of what was wrong)

- `profiles/shopify.json` used to say `"engine": "threejs"`, which was wrong: a Shopify
  storefront renders 3D through Google's **model-viewer**. **Closed.** `engines/model-viewer.json`
  exists and is enabled, and the profile now names it. The consequence is visible in the app:
  the target inherits the engine's decoder marks, so Meshopt and GPU instancing carry the
  yellow "needs a decoder" badge on Shopify while Draco, KTX2 and WebP do not.
- The sample sentence above — "Draco will not open here" — is **false**, and survives only as
  an illustration of the *shape* of an on-the-spot explanation. Checked 2026-08-10 and again
  2026-08-14 against model-viewer's sources: it supports Draco, KTX2/Basis and Meshopt, and
  only Meshopt needs the site to wire a decoder. Never reuse the wording as a claim.

### What model-viewer actually is (checked 2026-08-10)

This matters because it decides what `engines/model-viewer.json` will contain, and because the
easy answer — "Shopify is not a three.js target" — is misleading.

- **model-viewer is three.js.** `packages/model-viewer/package.json` declares
  `"three": "^0.183.0"` as a **peerDependency**. It is a web component wrapping three.js with a
  pinned version range, not a competing renderer.
- **Shopify's storefront uses it.** Shopify's own docs point at Google's `<model-viewer>`
  component; Hydrogen's `ModelViewer` pins `@google/model-viewer` 1.21.1.
- **It reads all three compressions — but not with the same defaults**
  (`modelviewer.dev/examples/loading/`):
  - Draco — supported; decoder fetched from a Google CDN on demand. Overridable via
    `ModelViewerElement.dracoDecoderLocation`.
  - KTX2 / Basis — supported; auxiliary decoder from the CDN on demand, via
    `ktx2TranscoderLocation`.
  - **Meshopt — supported but OFF by default.** The decoder is only used if
    `meshoptDecoderLocation` is set before the first element is created.

**The consequence for us, unresolved.** Every profile's `baselineOpts` uses
`"codec": "meshopt"`, including `shopify.json`. If a Shopify storefront does not set
`meshoptDecoderLocation`, a Meshopt file we produce for that target will not open there —
while the same file is fine on a plain three.js page that registers the decoder. This is a
difference in **engine defaults**, exactly the kind of fact the engine table exists to hold,
and it is the strongest evidence so far that splitting engine from target was the right call.
Not acted on: `shopify.json` is disabled, and the claim needs testing against a live
storefront before it drives a default.

Sources: `raw.githubusercontent.com/google/model-viewer/master/packages/model-viewer/package.json`,
`modelviewer.dev/examples/loading/`, `shopify.dev/docs/api/hydrogen/2024-04/components/media/modelviewer`.
- `GET /api/extensions` accepts an `engine=` parameter, defaulting to the target's engine.
  The request shape is ready before a second engine exists, so adding one is data, not a
  protocol change.

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
// tanyra3d.config.ts
export default {
  profile: 'web',                       // or path to custom profile
  rulePacks: ['@tanyra3d/rules'],       // + community packs
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

## 11. Decisions that were open at design review (and how they were resolved)

1. **Language** — proposed TypeScript. **Resolved twice.** At design review: plain JavaScript
   (ESM, `.mjs`). Reversed on 2026-08-10: the project moved to TypeScript module by module,
   and by 2026-08-11 every non-catalog module had followed. See §13 for what that means for
   anyone reading or building the code.
2. **Monorepo tool** — proposed pnpm workspaces. **Not resolved, because the question is not
   live yet:** the repository is flat and moves to `packages/*` only when the first external
   package appears (§3).
3. **License** — MIT vs Apache-2.0. **Resolved: Apache-2.0** (patent grant).
4. **Scope of v1 autofix**: `provable`+`numeric` only — should `perceptual` ever default to
   on for the `web` profile? **Resolved: no.** Everything is opt-in; the empty option set is
   a passthrough (§4b).

---

## 12. One-paragraph summary

Build a TypeScript monorepo whose `core` is a rule *engine* — rules analyze in parallel
(read-only), the engine plans fixes as a dependency DAG gated by a four-tier safety
taxonomy, applies only provably-safe fixes to a working copy, validates via invariants +
gltf-validator (+ later perceptual diff), and central reporters render the explained
result. Transforms are thin adapters over glTF-Transform / meshopt / toktx — never
reimplemented. Device targets are declarative profiles, not code. Ship a deep,
trustworthy analyze-only CLI first; earn trust with a golden-asset test corpus before
autofix; layer scoring, CI, and GUI surfaces onto the same core afterward.

---

## 13. Sources are TypeScript, the files you import are not (2026-08-11)

The repository stopped being plain JavaScript on 2026-08-10 and finished the move a day
later. Nothing about the shape of the project changed — only where the text you edit lives.

**The rule in one line: edit `.mts` / `.ts`, import `.mjs` / `.js`.**

| Layer | You edit | The compiler puts next to it | Project file |
|---|---|---|---|
| Engine, addon, top level | `core/engine.mts`, `addons/gltf/rules.mts`, `server.mts` | `core/engine.mjs`, … | `tsconfig.json` |
| Browser | `ui/app.ts`, `ui/viewer/viewer.ts` | `ui/app.js`, … | `tsconfig.ui.json` |

Consequences a newcomer will otherwise discover the hard way:

- **Every import path in the tree still ends in `.mjs` (or `.js`).** That is the file the
  runtime loads — the compiler emits it under the same name, in the same folder. No import
  was rewritten during the move, and none should be.
- **The built files are not in git and must not be added.** They are listed by name in
  `.gitignore` and guarded by `tests/typescript-build.test.mjs`. A checkout is not runnable
  until they exist.
- **`npm ci` builds them** — `npm run build` hangs on `prepare`, so a clean clone is ready
  to run. If installation fails with type errors, the tree is genuinely unbuildable:
  `noEmitOnError` means a single error emits nothing at all, on purpose.
- **`npm run typecheck`** checks both projects and writes nothing. It is what CI runs.
- **Message catalogs stay JavaScript, deliberately** — `core/messages/`, `addons/gltf/messages/`,
  `messages/`, `translations/`, `ui/locales/`. A translator edits those files; generating them
  would mean the next build silently discards their work. Their shape is described by
  hand-written `.d.mts` files sitting next to them, and those *are* in git.
- **Two compile projects, not one, because the environments differ**: Node globals and
  `.mts` → `.mjs` for the engine; DOM globals and `.ts` → `.js` for the browser. Mixing them
  would let server code "see" `document`.
