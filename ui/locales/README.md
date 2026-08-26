# Interface languages

The project uses two catalog folders:

- **`ui/locales/`** — English catalogs only: `en.js`, `validator-en.js`. English is the
  language `i18n.js` falls back to when a key is missing. Files here are served under
  `/locales/*`.

- **`translations/`** (in the project root) — every other language: `ru.js`,
  `validator-ru.js` and so on. Files here are served under `/translations/*`.

Two files there give you the **interface chrome** — buttons, labels, log lines. That is a
real, useful half, but it is a half: everything the server computes (platform descriptions,
option labels, the 📖 booklets, the whole report) has its own catalogs. The full cost is
five files, listed under "A complete language" below.

`server.mjs` reads both folders on every page request and wires up whatever it finds.

## How to add a language

1. Copy `translations/ru.js` to a file named after the language code — `translations/de.js`,
   `translations/zh.js`, `translations/es.js`.
2. Translate the values. **Don't touch the keys** — that's how the code finds a string.
3. Copy `translations/validator-ru.js` to `translations/validator-de.js`,
   `translations/validator-zh.js` and so on, and translate the glTF-validator messages.
4. Reload the page. A button with the language code appears in the header by itself.

At this point the interface speaks your language and the report still speaks English.

## A complete language

Three more catalogs, and they are plain data files — copy, translate, done. No code changes
anywhere, and nothing in `core/` to open:

| file | what it translates |
|---|---|
| `messages/<code>.mjs` | the report: summary, budgets, warnings |
| `core/messages/<code>.mjs` | engine strings: metric names, autofix policy |
| `addons/gltf/messages/<code>.mjs` | rule strings: "what was done", analysis findings |

Each folder is **read as a folder** — put the file in, the language appears. Until
2026-08-26 these three were static imports in three code files (`assistant.mts`,
`core/engine.mts`, `addons/gltf/index.mts`), so a new language meant editing the engine.
The audit measured that cost and it was removed; the mechanism is `loadCatalogs()` in
`core/i18n.mts`.

A missing catalog is not an error — those strings fall back to English, same as a missing
key does.

The file starts with two mandatory lines that put the catalog where `ui/i18n.js` looks for it:

```js
window.I18N_CATALOGS = window.I18N_CATALOGS || {};
window.I18N_CATALOGS.de = { /* ... */ };
```

## Khronos validator messages

`validator-en.js` / `validator-ru.js` translate `gltf-validator` messages by error code
(`validator.<CODE>`). Every code the package defines is currently translated. When a code is
missing from the catalog, the validator's own English text is shown: the mechanism in
`ui/app.js` (`translateValidatorMessage`) is designed for exactly that, so a missing
translation breaks nothing.

The full list of codes is `node_modules/gltf-validator/ISSUES.md`. Reconciliation between the
catalogs and that list is guarded by `tests/locale-keys-symmetry.test.mjs`: an orphan in the
catalog or a missing package code turns the run red. Translations may be added in batches,
but the pair must stay symmetric.

## What may be absent from the file

A missing key falls back to `en.js`. An incomplete translation does not break the interface —
English appears in its place. So you can start with any part of it and fill in the rest later.

`en.js` is always loaded first: it is the language everything falls back to.

## A value is either a string or a function

A string with substitutions:

```js
'status.phase': 'Phase {n}: {name}',
```

A function where the language requires agreement. Russian has three plural forms against
English's two, and substitution alone does not solve that:

```js
'log.sourceInspected': ({ n }) => `Проверено — ${n} ${window.I18n.plural(n, ['замечание', 'замечания', 'замечаний'])}`,
```

The form-selection rule for a new language is added to `plural()` in `ui/i18n.js`. This is
the **one** place where a code change may still be needed, and only for languages whose
plural rules differ from English and Russian — Polish and Czech have their own, Chinese and
Japanese have none at all. German, French, Spanish and Portuguese work with what is there.

## What this catalog does NOT translate

Text that arrives from the server:

- the report's summary, budgets and warnings — `assistant.mjs`;
- platform names and descriptions, and option hints (the 📖 booklets) — `profiles/*.json`;
- processing-rule strings ("what was done", analysis findings) — `addons/*/messages/`.

Add-on rule messages stay English deliberately: an add-on may be somebody else's, and
requiring its author to translate into every language is a reliable way to get no add-ons.
Translating them is the same move as everything else: put `<code>.mjs` next to `en.mjs` with
the same keys, and not a line of the rules is rewritten.
