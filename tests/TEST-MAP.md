# Test map — what is checked where, and where new tests go

> **Read this BEFORE adding a test.** The rule is simple: find the layer your check belongs
> to, then look at whether that layer already covers it. A new file is created only if no
> existing layer fits — and then this map is updated in the same commit.

On a clean clone some tests skip gracefully: the models they need are local-only and are not
in the repository.

---

## Five layers

The layers are ordered by **how well a check survives a change of platform**. The higher the
layer, the more valuable it is: Babylon arrives in 0.2.0, then FBX/USD through
`core/registry.mjs`, and layers 1–3 move across without a single edit.

### Layer 0 — architecture: boundaries and contracts (`tests/architecture/`)

The only layer that protects the **structure** rather than the behaviour. Every other test in
the suite would stay green if `import * as THREE from 'three'` appeared in `core/engine.mjs`
tomorrow.

| File | What it guards |
|---|---|
| `addon-contract.test.mjs` | the add-on contract is derived from the engine SOURCE; a mock add-on for an invented `.mock` format passes all five phases; a mock RULE is planned, applied and reported — without a line of glTF |
| `layer-boundaries.test.mjs` | the import graph by layer (`es-module-lexer`): `core/` knows nothing of three, gltf-transform or add-ons; the composition root is only `optimize2.mjs` / `server.mjs` |
| `registry.test.mjs` | `core/registry.mjs`: registration, resolution by extension, the seam for a SECOND format |
| `public-api.test.mjs` | a contract snapshot of RunResult / listRules / the assistant's exports: catches renames and removals, not growth |
| `no-cycles.test.mjs` | there are no cycles in the import graph |

**Anything to do with new add-ons goes here.** When an FBX add-on appears, its contract is
checked by the same `addon-contract` rather than by a new file: the method set is taken from
the engine, not rewritten.

### Layer 1 — the engine contract: promises independent of the viewer

| File | What it guards |
|---|---|
| `engine-contract.test.mjs` | the shape of the result; "a rule either did it or explained why not"; every record is translatable; no orphan keys; metrics agree with the written file; `runAfter` ordering |
| `report-honesty.test.mjs` | one class of cases, one line; the skip reason is the real one; number agreement |
| `report-density.test.mjs` | report density: no `messageId` appears in a report more than three times |
| `i18n-discipline.test.mjs` | text apart from code, checked mechanically: every record carries its recipe, no finished strings in engine code, catalog symmetry and plural forms, switching language recomputes nothing |
| `locale-keys-symmetry.test.mjs` | en↔ru catalog symmetry; `validator.*` keys are reconciled against the real code list of the `gltf-validator` package (ISSUES.md) — no orphans and no gaps; and the shape of the phrase itself (sentence ending, no extension or loader names) |
| `russian-locale.test.mjs` | the Russian version has no untranslated terms (the allowlist is deliberate) |
| `analyse-baseline.test.mjs` | the test count has not fallen below the baseline, and every repository model is on disk |

### Layer 2 — properties of the output FILE

Also viewer-independent, and for a stronger reason: Babylon reads the same glTF. What is
checked is the **file**, not a metric from the report.

| File | What it guards |
|---|---|
| `golden-corpus.test.mjs` | the reference models: licenses, passthrough, the basic pipeline, triangle and join invariants |
| `model-situations.test.mjs` | parameterized by SITUATION rather than by filename: model classes, preservation of skins/morphs/animations, idempotence |
| `feature-combos.test.mjs` | every feature pair, triples, and mutually exclusive pairs in both orders |
| `quantize.test.mjs`, `webp.test.mjs`, `ktx2.test.mjs`, `draco.test.mjs` | one rule's policy and its refusals |
| `skin-rules.test.mjs` | the four skinning rules (ROADMAP §5b1) on models built in the test itself — no skinned model is redistributable, so the corpus cannot cover them; the validator codes must disappear and no new one may appear |
| `ktx2-colorspace.test.mjs`, `large-texture.test.mjs` | narrow properties of the texture path |
| `texture-size.test.mjs` | the largest texture side is measured (longer side, not area) and compared against the platform threshold; zero means "nothing to measure", never a green "within budget" |
| `texture-resize.test.mjs` | downscaling to 4096/2048/1024/512: only what is larger is shrunk, proportions are kept, enlargement never happens, GPU-compressed textures are refused out loud, and the record is marked irreversible |
| `user-profiles.test.mjs` | a profile dropped into the user folder shows up and works; its thresholds are marked as the user's own; a file with a built-in id never shadows the built-in profile |
| `profile-form.test.mjs` | the form writes a working platform from a name, an engine and a few numbers; an empty field means "no threshold" and not zero; a built-in platform cannot be overwritten or removed; the field list is the budget metrics themselves, so it cannot drift apart from what is actually checked |
| `vertices-stored.test.mjs` | "drawn" and "stored" vertices count different things — shared geometry, a mesh outside the scene, and `join` unfolding copies; the stored count stays out of the baseline snapshot, where only what must not change is compared |
| `gap-005-regression.test.mjs`, `post-gap005-corpus.test.mjs` | the baseline checkpoint and what it catches |
| `write-policy.test.mjs` | when a file is written and when it is not |

### Layer 3 — robustness and scale

| File | What it guards |
|---|---|
| `input-folder.test.mjs`, `input-folder-matrix.test.mjs` | the local `input/` models × flag sets (the matrix only under `FULL_MATRIX=1`) |
| `heavy-stress-input.test.mjs` | models above the size threshold in `input/` |
| `corrupted-input.test.mjs` | broken and truncated files: the engine answers instead of crashing |
| `parallel.test.mjs` | concurrent calls don't interfere with each other |
| `more-features.test.mjs`, `optimize.test.mjs` | the basic API regression |
| `animation-resample.test.mjs` | the only rule that deliberately touches animation |

### Layer 4 — rendering (`*.browser.test.mjs`)

**The only layer tied to a viewer engine.** three.js has its own loader and its own forgiven
violations. When Babylon appears, a SECOND ADAPTER is written, not a second body of
scenarios: what to check is a shared table, how to check it is the adapter.

| File | What it guards |
|---|---|
| `viewer-regression.browser.test.mjs` | loading, statistics, `detectSource` across the corpus |
| `instance-grid-render.browser.test.mjs` | rendering after `safe+quantize+join` — the positions are unchanged |
| `parkergirl-render.browser.test.mjs` | morphs and skinning after `safe+quantize` — no artefacts |

### Separately — the setup script

`setup-script.test.mjs` guards `scripts/setup.mjs`, which is not the engine but is the first
thing a new contributor runs. It covers the branch that is unreachable on a machine where
`ktx` is already installed — the one that downloads a foreign executable and could hang
waiting for an answer where nobody is there to give one. The branch is reached through the
`TANYRA_SETUP_NO_KTX=1` seam documented in the script itself; nothing is downloaded.

### Separately — the defect register

`bugs-found.test.mjs` is not a layer but a **journal**. Each TESTBUG-xxx carries the defect's
history, reproduction steps and an open/closed status. A closed one turns into a regression
test. A finding that has no place in the layers yet goes here.

---

## Where a new test goes — three questions

1. **Is it about the structure of the code** (who imports whom, what an add-on must
   implement)? → layer 0, `tests/architecture/`. Most likely an addition to an existing file.
2. **Is it true regardless of who opens the file?** → layer 1 (an engine promise) or layer 2
   (a file property). Ask yourself: am I checking the REPORT or the FILE? Report is layer 1,
   file is layer 2.
3. **Is it about how the model looks on screen?** → layer 4, and only there.

If none of the three fits, the check probably isn't needed — or it is a finding for
`bugs-found.test.mjs`.

## How not to breed duplicate tests

- **Parameterize by situation, not by model name.** `tests/helpers/model-situations.mjs`
  derives a model's class from the file itself. A new model lands in its classes on its own,
  without being added to twenty places by hand.
- **Take the feature list from `RULES`, don't retype it.** `feature-combos` and
  `engine-contract` already do: when a ninth feature appears, the matrix grows by itself.
- **Shared things go in `tests/helpers/`.** Already there: `model-files.mjs` (repository vs
  local models), `model-situations.mjs` (classes), `report-density.mjs` (the density guard),
  `viewer-test-utils.mjs` (browser utilities). The same check copy-pasted into two files is a
  reason to extract a third helper, not a reason to copy again.
- **Before creating a new file, grep this map.** "Skins are not lost" already lives in three
  places for three different reasons (the baseline checkpoint, the `skinned` class, the
  quantization guard); a fourth copy would add nothing.

## What the layers deliberately do NOT cover

- **Performance** — there are no measurements, and none are planned before 0.1.0.
- **Mutation testing, property-based testing, fuzzing** — explicitly deferred
  (`docs/АРХИТЕКТУРНЫЕ_ТЕСТЫ.md` §5, in Russian).
- **A `heavy` class in `fixtures/`** — heavy models are not in the corpus and will not be
  (licensing and size); stress testing runs over `input/`, which is absent on a clean clone.
