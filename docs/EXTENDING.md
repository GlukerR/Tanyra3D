# Tanyra3D — Extension Model

> How the project grows over the long run. This is designed from the start but **built only
> as needed** — no extension point is built before it pays for itself (§5). A companion to
> `ARCHITECTURE.md`.
>
> **Where the code you write lives.** Since 2026-08-11 rules and addons are TypeScript:
> the file you edit is `addons/gltf/rules.mts`, the file that gets imported is the
> `rules.mjs` the compiler puts beside it. Rule and addon shapes are declared in
> `core/types.mts` and `addons/gltf/types.mts` — write against them and the compiler will
> tell you what a rule owes the engine. `ARCHITECTURE.md` §13 has the mechanics.

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

---

## 5d. Площадка-профиль: что ею является, а что нет (Александр, 2026-08-18)

Не путать с §5 выше: там «платформа» означает экосистему с плагинами, здесь — файл
`profiles/*.json`, описывающий ЦЕЛЬ, куда человек отдаёт готовую модель.

### Проверка перед тем, как заводить профиль

Три вопроса, и все три должны ответить «да»:

1. **Это АДРЕС, куда модель отдают?** Не устройство, не браузер, не класс техники —
   конкретное место, у которого есть свои требования к присланному файлу.
2. **Оптимизируем МЫ, а не они?** Если площадка сама пережимает всё присланное, наша
   работа там выбрасывается, и профиль обещает то, чего не будет. Это отдельная граница,
   её провёл Александр 2026-08-18 — см. `MISSION.md`, раздел про закрытый список.
3. **Есть ли ЧИСЛА ИЛИ ЗАПРЕТЫ ИЗ ПЕРВОИСТОЧНИКА?** Профиль без своих чисел отличается
   от прочерка только подписью.

**Разобранный случай ошибки.** `mobile.json` и `quest.json` прожили в дереве с 29 июля по
18 августа и не прошли первый же вопрос: «Смартфоны» и «Meta Quest» — КЛАССЫ УСТРОЙСТВ.
Модель никуда не «отдают на смартфон»; её отдают на сайт, который открывают с телефона, и
требования выставляет сайт. Держались они на выдуманном `"engine": "threejs"` (браузер
телефона и шлема запустят что угодно) и на числах-советах без первоисточника. Оба удалены;
восстановить, если понадобятся, — `git show <коммит>^:profiles/mobile.json`.

Отличать от них Google Store, который тоже не место для загрузки: у него есть НАЗВАННОЕ
командой число (2 МБ с текстурами) и названный движок. Он проходит по вопросу 3 и потому
полезен как эталон, а не как адрес.

### Профиль ВЫЧИТАЕТ, а не перечисляет

Главное правило, и оно определяет весь состав файла. Что модель умеет — знает движок
(`engines/*.json`); что необратимо и что теряется — знает правило (`addons/gltf/rules.mts`).
Площадка добавляет ровно две вещи:

- **свои числа** (`budgets`) — пороги, которых нет ни у кого другого;
- **свои запреты** (`excludeExtensions`) — что здесь НЕ ЧИТАЕТСЯ, и такая опция исчезает
  из панели совсем.

Всё остальное площадка НЕ ПОВТОРЯЕТ. Список опций, их названия, описания, обратимость,
уровень потерь в профиле не пишутся — они уже есть, и вторая копия разойдётся с первой
молча. Это не теория: до §4g список расширений лежал в каждом профиле ЧЕТЫРЬМЯ побайтно
одинаковыми копиями, и каждая новая площадка означала повторный перевод десяти опций.

В интерфейсе это тот же принцип и теми же словами: «Включено всё, что умеет движок.
Снимите то, что эта площадка не читает» (`profile.features.hint`). Человек, заводящий свою
площадку, ничего не перечисляет — он снимает лишнее.

### Когда вычитать, а когда предупреждать

Вычитание прячет опцию, и потому требует ЗНАНИЯ, а не подозрения. Правило 12 называет это
единственным законным способом не показать работающую с виду клавишу — «действие физически
невозможно». Отсюда граница, разобранная на двух живых случаях 2026-08-18:

- **VNTANA и Draco — вычитаем.** Их документация говорит прямо: файл с Draco не даёт
  выходов вообще. Известно, из первых рук, и исход однозначен.
- **Shopify и Meshopt — НЕ вычитаем, ставим жёлтый значок.** Подключён ли декодер на
  витрине, снаружи выяснить не удалось. Решение Александра: «не принудительно, а просто
  значок жёлтый поставить как есть». Убрать работающую опцию так же плохо, как оставить
  неработающую.

Сомнение решается в пользу показа с предупреждением, а не в пользу запрета. Значок
«нужен декодер» при этом ставит ДВИЖОК (`needsDecoder`), а не площадка: «умеет» — свойство
читателя и верно везде, «подключено» — свойство конкретного развёртывания.

### Числа без источника не пишутся

У каждого порога либо `source` со ссылкой на документ площадки, либо `note` со словами
«источника нет». Пустая строка хуже отсутствующей: она выглядит как решение автора.
Дописывать недостающие пороги «для симметрии» нельзя — `google-store.json` несёт ровно
один бюджет именно поэтому, и тем он и ценен.

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
if (names.length === 1) out.skipped.push({ messageId: 'ktx2.skipped.already', data: { name: names[0] } });
else if (names.length > 1) out.skipped.push({ messageId: 'ktx2.skipped.already.many', data: { n: names.length } });
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

## 5c. Mandatory: the truth lives in the ORIGINAL file, never in an intermediate

Alexander, 2026-08-15, verbatim: *«брать за основу только первоначальный файл и последний
всегда проверять с самым первым, а не с промежуточными нашими. Для всех проверок и тестов
это должно быть правилом»* — take the original file as the basis, and always check the last
against the very first, not against our intermediates. For every check and every test.

**Where this came from.** Restoring extensions the library does not know used to rely on a
registry keyed by the *document object*. The KTX2 rule re-encodes images with an external
tool and therefore round-trips through a temporary file — `ctx.document = await
io.read(tmp)`. After that the document is a **different object**, the registry has no entry
for it, and there was nothing left to restore. Pointer animation vanished on exactly one
checkbox out of ten. The defect was not in KTX2 and not in the restore logic: it was in
**what we treated as the source of truth**.

Concretely, this means:

- **A comparison always has the input file on one side.** Not a snapshot taken halfway,
  not a document held in memory. `writeBytes(io, doc, src)` takes the source path and
  recomputes what to restore from the file on disk at write time.
- **An intermediate may be replaced at any moment, and nothing must depend on its
  identity.** A rule is free to swap `ctx.document` — that is a legitimate technique, not a
  violation. What is forbidden is holding state that only that object can unlock.
- **The same applies to tests.** Assert against the input file, not against an earlier
  stage of your own pipeline. A test comparing stage 3 to stage 2 stays green while both
  drift away from what the person actually handed us.

Guards live in `tests/bugs-found.test.mjs` under «правило истины»: a structural one (the
signature must demand the source) and a behavioural one (whatever the input declares must
be present in the output, under every flag set — including the one that swaps the
document).

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
