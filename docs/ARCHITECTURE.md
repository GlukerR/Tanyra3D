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
