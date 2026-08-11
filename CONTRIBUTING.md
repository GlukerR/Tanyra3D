# Contributing

Thanks for looking. Below is what's worth knowing before your first change: not
formalities, but a handful of principles — each introduced after breaking it cost
somebody time.

[Русская версия](CONTRIBUTING.ru.md)

## Getting started

```bash
git clone https://github.com/GlukerR/Tanyra3D.git
cd Tanyra3D
npm install
npm run setup -- --tests
npm test
```

The suite should be green straight after cloning. If it isn't, that's a bug on our side —
please open an issue.

`npm run doctor` re-checks your environment without changing anything.

### The sources are TypeScript — edit `.mts`/`.ts`, import `.mjs`/`.js`

`npm install` compiles them (the build hangs on `prepare`), and the compiler puts the result
next to the source under the same name: `core/engine.mts` → `core/engine.mjs`. That is why
every import in the tree still ends in `.mjs` — it is the file the runtime loads. The built
files are not in git; a fresh checkout is not runnable until you install.

Two things surprise people:

- **If installation fails on type errors, nothing was written at all.** `noEmitOnError` is on
  deliberately — a half-built tree would run on stale files and lie about the cause.
- **Message catalogs stay JavaScript on purpose** (`core/messages/`, `translations/`,
  `ui/locales/` and friends). A translator edits those; generating them would let the next
  build discard their work.

`npm run typecheck` checks both compile projects (engine and browser) and writes nothing.
Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §14.

Design overview: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Adding your own rule:
[`docs/EXTENDING.md`](docs/EXTENDING.md).

## The core principle: nothing happens silently

This isn't a style preference, it's the point of the product. Somebody hands over a file
they paid for, and must get back either something they understand or an honest refusal.

It follows that **every rule must explain itself**: what it found, what it did, what it
declined to do and why. A rule that quietly did nothing is a defect, even if it broke
nothing.

## Five rules people trip over most

### 1. Everything is off by default

An empty list of optimizations means the file is read, validated and written back
unchanged. A new rule arrives disabled. Only what is provably safe turns itself on.

### 2. Text lives apart from code

Not one string a human will read belongs in logic — not in the engine, not in the rules,
not in the interface. Everything is looked up by key from catalogs: `ui/locales/`,
`translations/`, `addons/*/messages/`, `core/messages/`.

Three consequences, all of them violated at some point:

- **Never concatenate a string in code.** "Title — reason", "File: X → Y (Z)" is one
  message with substitutions, not a sum of pieces. The separator and the word order
  belong to the language.
- **Switching language recomputes nothing.** It is a redraw: no reloading the model, no
  rebuilding, no resetting checkboxes. A finished report is translated without rerunning
  anything — records carry the recipe for their own strings (the `i18n` field).
- **A caption set by code is tagged with its key.** Otherwise translating the static
  markup rolls it back to the original value.

Details in `docs/ARCHITECTURE.md` §4b.

### 3. One record per class of cases, not per element

A rule walking a list (textures, meshes, attributes, nodes) returns **one** record about
the whole class. Twenty consecutive lines of "data map stored as JPEG" is a defect, not
detail.

Collapse at the source, not in the interface: the interface only sees finished strings
and will lie if it tries. Plural forms get their own key (`*.many`) — number agreement
belongs to language, not to substitution.

This does not apply to logs. There, one line per element is right: it's an event stream.

Mechanics in `docs/EXTENDING.md` §5b.

### 4. Hints are written for a beginner

An option's hint answers two questions: **what does this give me** and **what does it
cost me**. Nothing else.

Don't put spec extension identifiers (`EXT_texture_webp`, `KHR_texture_basisu`), library
or loader names, or engine names into them. Technology names already in the option's
title (KTX2, Draco, Meshopt, WebP) stay — people search the internet for those, and an
extension identifier is not the word anybody searches for.

One test: **would an artist who just opened the program and knows none of these words
understand this?** If not, rewrite it rather than adding a parenthetical.

### 5. The result is verified, not assumed

After processing, the engine compares the model against a snapshot taken beforehand:
triangles, vertices, draw calls, skins, animations, morph targets, attribute set. If
anything drifted, a red warning appears at the top.

A new rule must not be able to break that invariant unnoticed. If it legitimately changes
one of those things, the report has to say so.

## Tests

Integration tests: real models through the real pipeline, no mocks. Where to put a new
test is described in [`tests/TEST-MAP.md`](tests/TEST-MAP.md) — five layers and the rule
for choosing between them.

What you must not do in tests, even when it turns things green faster:

- **weaken an assertion** so it stops catching anything (a 5% threshold must not become
  50%, `toBe` must not become `toBeDefined`);
- **skip a test without stating the reason in its name** — a skip has to say what's
  missing;
- **update snapshots blindly**, without looking at what changed.

The repository ships a small model corpus built for testing. Models under third-party
licenses are not included: tests that need them are skipped with the reason stated. If
your test needs a model that isn't in the repository, use the existing helpers in
`tests/helpers/model-files.mjs` rather than calling `fs.existsSync` by hand.

Adding a model to the corpus? Put a `.license.md` next to it stating its origin and
whether it may be redistributed. Without that the model isn't accepted.

## Submitting changes

- One branch per task: `feat/<short>` or `fix/<short>`.
- One commit per meaningful change.
- In the commit message, **why** matters more than *what* — what is visible in the diff.
- A comment in the code explains the reason, it doesn't restate the line next to it.
- `npm test` green before you send it.

## Language

Everything on the contributor's path is in English: the README, this document, the
architecture and extension docs, the test map, the corpus and locale READMEs, and the
interface catalogs.

The project grew up in Russian, so the code comments still are, along with some reference
documents under `docs/` (dependency rationale, budget sources, the wording glossary).

**Contributions in English are welcome**, including translations of what is still in
Russian — that's a genuinely useful first contribution. You don't need Russian to work on
the engine, and issues in English get answered in English.

## License

Apache-2.0. By submitting a change you agree it is distributed under the same terms.
