# Interface languages

The project uses two catalog folders:

- **`ui/locales/`** — English catalogs only: `en.js`, `validator-en.js`. English is the
  language `i18n.js` falls back to when a key is missing. Files here are served under
  `/locales/*`.

- **`translations/`** (in the project root) — every other language: `ru.js`,
  `validator-ru.js` and so on. Files here are served under `/translations/*`.

Adding a language means putting two files into `translations/`. Nothing else: `server.mjs`
reads both folders on every page request and wires up whatever it finds.

## How to add a language

1. Copy `translations/ru.js` to a file named after the language code — `translations/de.js`,
   `translations/zh.js`, `translations/es.js`.
2. Translate the values. **Don't touch the keys** — that's how the code finds a string.
3. Copy `translations/validator-ru.js` to `translations/validator-de.js`,
   `translations/validator-zh.js` and so on, and translate the glTF-validator messages.
4. Reload the page. A button with the language code appears in the header by itself.

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

The form-selection rule for a new language is added to `plural()` in `ui/i18n.js` — that is
the only place where a code change may be needed.

## What this catalog does NOT translate

Text that arrives from the server:

- the report's summary, budgets and warnings — `assistant.mjs`;
- platform names and descriptions, and option hints (the 📖 booklets) — `profiles/*.json`;
- processing-rule strings ("what was done", analysis findings) — `addons/*/messages/`.

Add-on rule messages stay English deliberately: an add-on may be somebody else's, and
requiring its author to translate into every language is a reliable way to get no add-ons.
The mechanism for translating them is the same one and already works (`core/i18n.mjs`): put a
`ru.mjs` next to `en.mjs` with the same keys, and the rules are not rewritten.
