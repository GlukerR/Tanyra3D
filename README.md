<div align="center">

# Tanyra3D

**A 3D model optimizer for the web that tells you what it did — and why.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-brightgreen)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.0.9-orange)](#status)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#install)

Drop in a `.glb`, tick the boxes you want, get a smaller model back — along with a
report in plain language: what was found, what was applied, what was left alone, and
for what reason.

**Nothing happens silently.**

[Русская версия](README.ru.md)

</div>

---

## What it actually does

One run, real numbers, no flags and no configuration:

```
$ node optimize2.mjs

phase 3/5 · apply · basic (8 fixes)
  • Duplicate resources (dedup)   • Vertex weld
  • Unused resources (prune)      • Degenerate triangles
  • Mesh join (flatten + join)    • Geometry compression

phase 4/5 · validation
  [baseline-validate] triangles: 7500 → 7500
  [baseline-validate] drawCalls: 1 → 1
  [baseline-validate] skins: 0 → 0    animations: 0 → 0

[DONE] Instance Grid 01.glb: file 0.95 → 0.19 MB (−80%)
```

Five times smaller. Triangles, draw calls, skins and animations all intact — and that
is not a promise but a check: the engine compared the result against a snapshot taken
before the work started.

---

## How this differs from `gltf-transform optimize`

The stock `gltf-transform optimize` command enables mesh simplification and texture
downscaling by default. For a product catalog or a portfolio that is unacceptable: the
model somebody paid for comes back coarser than it went in.

Two things are different here.

### Everything is off by default

An empty list of optimizations means the file is read, validated and written back
without a single change. Each optimization is enabled explicitly and comes with an
honest description: what it does, whether it is reversible, whether data is lost, and
whether the target site needs a decoder for it.

### The result is verified, not assumed

After processing, the engine compares the model against a snapshot taken beforehand:
triangles, vertices, draw calls, skins, animations, morph targets, attribute set.

If anything drifted, a **red warning** appears at the top listing the differences, and
the report explains what broke. The file is still written and can still be downloaded —
whether the result is good enough is the human's call, not the tool's.

> Quietly handing back a broken model whose damage isn't visible to the eye is the one
> thing this tool will not do.

---

## What it can do

| Optimization | What it does | Data loss | Decoder needed on site |
|---|---|---|:---:|
| **safe** | Deduplicate materials and textures, drop unused data and UV channels, weld matching vertices, cut degenerate triangles | none | no |
| **join** | Merge meshes — fewer draw calls | none, but parts stop being separate objects | no |
| **instance** | Repeated meshes → GPU instancing | none | no |
| **meshopt** | Geometry compression | none | yes |
| **draco** | Geometry compression, stronger and slower | none | yes |
| **quantize** | Pack geometry numbers tighter | barely visible | **no** |
| **ktx2** | Textures to KTX2: saves both download and video memory | barely visible | yes |
| **webp** | Textures to WebP | barely visible | no |
| **resample** | Thin out redundant animation keyframes | none | no |
| **strip-colors** | Remove vertex colors | **yes**, opt-in only | no |

None of them changes the polygon count. Mesh simplification is deliberately absent.

<details>
<summary><b>Why instancing gets ticked automatically</b></summary>

<br>

`instance` turns itself on when shared geometry is found — several nodes pointing at one
mesh. This isn't only about saving draw calls.

`join` has to bake each node's transform into the vertices, which means **multiplying
shared geometry into copies**. Nodes carrying instancing it doesn't touch at all. On the
chess set from the Khronos reference models, the difference between "join without
instancing" and "with it" is **75.5 MB versus 41.0 MB** for the same draw-call result.

</details>

---

## How it works

```mermaid
flowchart LR
    A[Model] --> B[Analyze]
    B --> C[Plan]
    C --> D[Apply]
    D --> E[Verify]
    E --> F[Report]

    B -.->|structure snapshot| E
    E -.->|mismatch| G[Red<br/>warning]
    F --> H[Result<br/>+ .md report]
    G --> H
```

Every optimization is a self-contained rule carrying its own metadata: how serious the
finding is, whether the fix is provably safe, whether it is reversible, which data it
touches, which other rules must run first. The engine builds the order itself and
decides what to apply: anything up to "invisible to the eye" runs automatically, while
anything lossy requires an explicit opt-in.

The core (`core/`) knows nothing about glTF. Everything format-specific lives in an
add-on (`addons/gltf/`). That split exists for the sake of a second format, not for
elegance.

---

## Install

You need [Node.js](https://nodejs.org/) 18 or newer. Works on Windows, macOS and Linux.

```bash
git clone https://github.com/GlukerR/Tanyra3D.git
cd Tanyra3D
npm install
npm run setup
```

Then `npm start` and the program opens at `http://localhost:3210`. That is the whole of it —
four lines and no decisions to make.

`npm install` pulls everything installable from npm, including the texture encoding CLI.
`npm run setup` checks your environment and offers to install the one thing npm cannot.
Neither downloads a browser: the tests need one, the program does not.

> The lines are separate on purpose. Joining them with `&&` fails on **Windows PowerShell
> 5.1**, which is still what a fresh Windows 10 or 11 gives you — `&&` arrived in PowerShell
> 7, a separate install. Four lines work in every shell.

**You do not need to run the tests to use this.** They exist for people changing the code;
if that is you, see [Tests](#tests) below.

<details>
<summary><b>What <code>npm run setup</code> does</b></summary>

<br>

```
Tanyra3D — environment check

  ✓ Node 20.11.0
  ✓ Dependencies installed
  ✓ Texture encoding tool (@gltf-transform/cli)
  • KTX2 encoder not found — KTX2 texture compression unavailable
    Everything else works without it.
    Download and install KTX-Software 4.4.2 from the official Khronos release? [y/N]
```

There is exactly one thing npm cannot install: `ktx` from **KTX-Software**, a native
Khronos program. The script offers to fetch it from the official Khronos release — and
only after you say yes. Answer no and it prints how to install it yourself; nothing else
changes.

How it installs depends on what Khronos publishes for your system. On **Linux** there is
an unpackable archive, so it lands inside the project (`.tools/`) with no administrator
rights and its checksum is verified. On **Windows and macOS** only installers are
published, so the official installer runs and your system asks for confirmation the usual
way. Those two have no checksum published alongside them; the download is over HTTPS from
`github.com`, which is what actually protects it.

Run `npm run doctor` any time to re-check without changing anything, and
`npm run setup -- --yes` to skip the question in a script. Without a TTY — in CI, or
through a pipe — the question is never asked, so nothing can hang waiting for an answer.

Without `ktx`, everything except KTX2 compression works normally, and KTX2 says plainly
that the tool is missing instead of failing obscurely.

</details>

---

## Three ways to run it

### Web interface

```bash
npm start
```

Opens `http://localhost:3210`. Drag in a model, pick a target platform, tick the
optimizations, press **Build optimized model**. Source on the left, result on the right,
before/after numbers and the report in between. The model plays in both viewports at
once, sharing camera and animation time.

Everything runs locally. Models are never uploaded anywhere.

### Command line

```bash
node optimize2.mjs                          # preset: safe + meshopt + join
node optimize2.mjs draco                    # same, Draco instead of Meshopt
node optimize2.mjs --keep-parts             # without merging meshes
node optimize2.mjs --ktx2                   # add texture compression
node optimize2.mjs --dry-run                # full analysis and report, writing nothing
node optimize2.mjs --passthrough            # apply nothing, just validate
```

Input comes from `input/`, results and an `name.report.md` land in `output/`. The whole
folder is processed at once — that is the batch mode; the web interface handles one
model at a time.

> [!NOTE]
> On the command line, running without flags applies a preset rather than a passthrough.
> That's historical, and the behaviour is preserved so existing scripts don't break. The
> programmatic and web interfaces do nothing by default.

### Programmatic

Five exports, and they fit on one screen:

```js
import {
  optimizeFile,   // run the pipeline over a file
  inspectFile,    // metadata + validation, changing nothing
  exportJson,     // the asset as self-contained JSON
  listRules,      // every rule and everything it declares about itself
  VERSION,
} from './optimize2.mjs';
```

**Optimizing:**

```js
const result = await optimizeFile('model.glb', {
  advancedFeatures: ['safe', 'draco'],
  outDir: 'output',
});

console.log(result.status);              // 'ok' | 'fail'
console.log(result.metrics.before, result.metrics.after);
console.log(result.applied);             // what was actually applied
console.log(result.validation);          // validation results
```

**Analyzing without touching anything.** Two ways, and they answer different questions.
`inspectFile` reads the asset as it is; `dryRun` runs the whole pipeline and reports what
*would* happen, writing no file:

```js
await inspectFile('model.glb');          // { format, asset, extensions, metadata, validation }

const preview = await optimizeFile('model.glb', {
  advancedFeatures: ['safe', 'ktx2'],
  dryRun: true,                          // full analysis and report, nothing written
});
preview.findings;                        // what was found
preview.skipped;                         // what was not done, and why
```

**Asking what the engine can do.** `listRules()` returns each rule's full declaration —
enough to build an interface from, which is what the web interface does:

```js
listRules()[0];
// {
//   id: 'structure/dedup', category: 'materials', severity: 'info',
//   tier: 'basic', feature: 'safe', fixSafety: 'provable',
//   reversible: true, dataLoss: 'none', runAfter: [], touches: [...]
// }
```

`fixSafety` says how well the safety of the fix can be proven, `dataLoss` and `reversible`
say what it costs. Nothing about a rule is hidden from the caller.

The full contract is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4b.

---

## Tests

For people changing the code. If you only want to use the program, skip this section — the
tests take about ten minutes and tell you nothing you need.

```bash
npm run setup -- --tests
npm test
```

The first line adds the browser some tests drive — a few hundred megabytes, which is why it
is not part of the ordinary install. Without it: `npm test -- --project node`.

The tests are integration tests: real models through the real pipeline, no mocks.

The repository ships a small corpus of models built specifically for testing — a
deliberately dirty cube, a grid of linked duplicates, unlinked copies of one mesh
without normals, morph targets, vertex colors, already-compressed input, an
already-instanced scene, a scene with no geometry, a file that is nothing but textures,
two scenes in one file, a deliberately truncated file. Enough for the suite to be green
straight after cloning.

Tests that need heavier models are reported as skipped with the reason stated — visible
in the run output rather than dissolved into silence.

---

## Limitations

The honest list of what the tool doesn't do, or doesn't do fully.

- **Animation and skin verification is by count.** The engine makes sure clips and skins
  don't disappear, but doesn't compare their contents frame by frame. You can check by
  eye in the viewer.
- **`meshopt` on characters with morph targets** can corrupt skinning. The pipeline
  detects this and flags the result with a red warning — the file is written, but don't
  trust it; use `draco` instead.
- **Texture dimensions aren't checked.** The platform threshold is recorded and shown,
  but the core doesn't yet expose texture width and height.
- **One target platform** — web on three.js. Profiles for mobile, Quest and Shopify exist
  as data and carry real numbers (triangle and VRAM budgets, texture limits), but they are
  drafts: nobody has measured a model against them. They ship switched off (`enabled: false`)
  and are not offered in the interface.
- **Batch processing is command-line only**; the web interface takes one model at a time.

---

## Status

**0.0.9, early development.** Core, web interface and viewer work, the test suite is
green, there has been no public release yet. The API may still change.

Next up is a desktop application with an ordinary installer instead of a terminal.

The browser is the current shape, not the intent. The people this is built for shouldn't
have to work through a hundred checkboxes or launch anything from a terminal: install in
one click, drop in a model, get a result with an explanation.

---

## Why this exists

Small studios and artists working alone face the same weight and compatibility
requirements as large teams — but without the person who translates those requirements
into plain language.

That person is what the program is meant to be.

---

## Documentation

| File | About |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to contribute |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | core design, API contracts |
| [`docs/EXTENDING.md`](docs/EXTENDING.md) | how to add your own rule |
| [`tests/TEST-MAP.md`](tests/TEST-MAP.md) | the five test layers, and where a new test goes |
| [`fixtures/README.md`](fixtures/README.md) | the model corpus and its license policy |
| [`ui/locales/README.md`](ui/locales/README.md) | how to add an interface language |

Everything on the contributor's path is in English. The project grew up in Russian, so the
code comments and some reference documents under `docs/` still are — translating them is
welcome work, and a good first contribution.

---

## Contributing

Patches are welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md). It's short: five
principles, each of which was introduced after breaking it cost somebody time.

## License

[Apache-2.0](LICENSE).

Models under `fixtures/models/` marked as redistributable were made by the project author
and fall under the same license. The one exception is `Unlinked Duplicates 01.glb`: its
geometry is Suzanne, the Blender mascot; the origin is noted in its `.license.md`. Other
models used during development are not included in the repository — each has its own
license.
