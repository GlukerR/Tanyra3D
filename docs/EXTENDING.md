# Tanyra3D — Extension Model

> How the project grows over the long run. This is designed from the start but **built only
> as needed** — no extension point is built before it pays for itself (§5). A companion to
> `ARCHITECTURE.md`.

---

## 1. The shape: a small core, everything else a plugin

The core stays minimal and provides only: the application lifecycle, the shared data model
(glTF-Transform's `Document`), plugin loading, the execution pipeline (phases), validation
and reports. Everything beyond that is a plugin:

- Importers (FBX, OBJ, USD, …)
- Exporters (GLB, USDZ, FBX, …)
- Optimizers (Meshopt, Draco, KTX2, …)
- Validators
- Analysis rules
- Report generators
- Viewers
- Platform profiles

The core talks to plugins only through interfaces and never depends on their implementation
details. This is how an open project scales: the author builds the core, the community
carries the long tail of formats and rules — the way three.js, ESLint and Rollup do.

---

## 2. Not one API, but a set of typed extension points

Different plugins have different contracts, and forcing them into one uniform API does not
work:

| Extension point | Contract (simplified) |
|---|---|
| Importer | `bytes → Document` |
| Exporter | `Document → bytes` (target format) |
| Rule / Optimizer | `analyze / canFix / fix` over a `Document` |
| Validator | `Document/bytes → issues[]` |
| Reporter | `RunResult → string` (md / json / html / sarif) |
| Profile | data: budgets, weights, rule set |
| Viewer | inspecting a `Document` (read-only) |

What they share is the **envelope**: a manifest plus registration with the core. This is
exactly what ESLint does (rules / formatters / parsers are different interfaces) and what
Rollup does (a plugin with a set of optional hooks).

---

## 3. The plugin manifest

Every plugin declares:
- its name;
- its version;
- the Plugin API version it is compatible with;
- the capabilities it provides;
- optional dependencies.

(Real-world equivalents: `engines` / `peerDependencies` in package.json, and API versions in
ESLint plugins.)

---

## 4. CRITICAL: when to freeze the public API

A stable public Plugin API with a backwards-compatibility guarantee is an **expensive
promise**. Giving it early means freezing the wrong abstraction and then either carrying it
for years or breaking the compatibility you promised.

The right order:
- **Before 1.0** the plugin shape is internal and may break freely. It is proven on our own
  importers, rules and reporters.
- The `RULES` array is **already the seed** of a plugin system: every rule declares its meta
  (id, category, fixSafety, runAfter). The first step is done.
- Only once the shape has been proven by a dozen of our own plugins do we declare "Plugin API
  v1" — and from that moment the whole compatibility discipline in §3 switches on.

The rule: **proven-by-use first, stable-public second.** Don't pay for API stability before
it starts paying back.

---

## 5. The principle: a platform is a consequence, not a starting point

The ladder is `CLI → desktop → extensible desktop → open platform → ecosystem`.

But platforms are not born as platforms. They are born as tools that solve one problem so
well that a community gathers around them — and only then does an API appear. Three.js was a
renderer, VS Code an editor, ESLint a linter; the extension API arrived AFTER the traffic,
not before it.

What follows for priorities:
- **At this stage the quality of the core matters more than the API.** Safe optimization,
  explanations, and not ruining assets are what bring users in. The API becomes the most
  important thing later, when there is somebody to serve with it.
- Aiming straight at a platform means building infrastructure for users who have not arrived.
  Aiming at an excellent tool with clean seams means the platform grows by itself.
- The seams (rules as objects, profiles as data) are kept clean from the start — that part is
  cheap. The full plugin infrastructure gets built when demand accumulates.

---

## 5b. Mandatory for every rule: the AUTHOR collapses repetition, not the interface

**Introduced by Alexander on 2026-08-01, after the same defect surfaced for the third time in
a row — on a new feature.** It applies to every future engine, platform and add-on, not only
to glTF.

A rule that walks a list (textures, meshes, attributes, nodes, materials) must return **one
record for the whole class of cases**, not one record per element. Otherwise the right-hand
panel fills with a crowd of identical lines: twenty of "data map stored as JPEG" on one
model, eleven of "already WebP" on another, eight of "attribute unused" on a third.

The shape is two keys for one meaning:

```js
if (names.length === 1) out.skipped.push({ messageId: 'webp.skipped.jpegData', data: { name: names[0] } });
else if (names.length > 1) out.skipped.push({ messageId: 'webp.skipped.jpegData.many', data: { n: names.length } });
```

Three conditions, each of which has been broken and cost time:

1. **Collapse at the source, not in the interface.** The interface only sees finished strings
   and cannot honestly add them up: the attempt produced "attribute TEXCOORD_1 unused ×8" —
   one name given, eight meant. The rule knows the whole list at once, so the rule is the only
   place where collapsing comes out truthful.
2. **The plural form is a separate key (`.many`), not a substitution into the same string.**
   Word order and number agreement belong to language (text apart from code, see
   `ARCHITECTURE.md` §4b).
3. **Don't list the names in a collapsed line.** A dozen nameless dashes help nobody and make
   the line unreadable. The count is enough; whoever needs the names reads the logs. The
   exception is when the list itself is the substance of the finding ("unused attributes:
   TEXCOORD_1, TEXCOORD_2, …").

**Logs need no collapsing.** The log panel is an event stream, where one line per element is
appropriate and useful for diagnosis. The restriction applies to the report — "Analysis",
"What was done", "Skipped" — everything a person reads as a conclusion.

This is checked automatically: `tests/report-density.test.mjs` runs the corpus and fails if
any rule emits more than three records with the same `messageId`, and
`tests/i18n-discipline.test.mjs` guards the message-catalog side of the same discipline.

---

## 6. The community → official path

A successful community plugin gets reviewed and moves into the official distribution while
staying on the same public Plugin API. The line between "in the core" and "in a plugin" is
movable, as it is for VS Code and ESLint (some rules built in, some external). This is the
healthiest way for an ecosystem to grow.

---

## 7. In one line

Design as a small core plus typed extension points with a shared manifest; freeze the public
API only after proving it on our own plugins; don't build the platform directly — grow it
from an excellent core, keeping the seams clean.
