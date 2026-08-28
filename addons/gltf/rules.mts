// addons/gltf/rules.mjs — десять правил пайплайна glTF. Логика фиксов перенесена из
// optimize2.mjs без изменений; ВЕСЬ пользовательский текст вынесен в каталог
// (messages/en.mjs) — правила возвращают { messageId, data }, а не готовую строку
// (ядро рендерит их через core/i18n.mjs). Форма объекта-правила — см. core/types.mjs:
//   meta { id, category, title, severity, fixSafety, tier, runAfter, touches, enabled, ... }
//   analyze(ctx)          — фаза 1, только чтение
//   canFix(finding, ctx)  — { safe, messageId, data } (причина идёт в отчёт как ключ)
//   fix(finding, ctx)     — фаза 3, меняет ctx.document; возвращает { found/skipped/
//                           details/irreversible } — массивы { messageId, data }
//
// ВАЖНО (эквивалентность v2): бОльшая часть находок в glTF считается только по факту
// применения (diff до/после prune, вырожденные треугольники появляются ПОСЛЕ weld и
// т.д.). Поэтому analyze возвращает «задание» ({ messageId: 'pipeline' }), а конкретика
// с цифрами приходит из fix — ровно те же измерения, что делал v2.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as fns from '@gltf-transform/functions';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

import { render } from '../../core/i18n.mjs';

import type { Accessor, Document, Mesh, Node, Primitive, Texture } from '@gltf-transform/core';

import type { FixDecision, FixOut, GltfContext, GltfRule } from './types.mjs';
import type { Finding, Message } from '../../core/types.mjs';

/**
 * Часть @gltf-transform/functions, которую правило KTX2 передаёт помощнику. Аргументом,
 * а не импортом: помощник вызывается и с настоящим модулем, и с подменой в тестах.
 */
interface TextureSlotFns {
  listTextureSlots: (tex: Texture) => string[];
}

/** Текстура-кандидат на перекодирование в WebP плюс исход попытки. */
interface WebpCandidate {
  tex: Texture;
  name: string;
  mime: string;
  isData: boolean;
  /** сообщение отказа кодировщика; поле появляется только на неудачной ветке */
  failed?: string;
  /** картинку пришлось сперва распаковать из формата видеокарты (KTX2) */
  fromGpu?: boolean;
  /** кодировали без потерь (исходник без потерь, и человек не сдвинул ползунок) */
  lossless?: boolean;
  /** как узнали качество исходника — попадает в отчёт одной строкой на класс */
  how?: Ceiling['how'];
  /** качество исходника, если его удалось узнать: то самое «примерно 83» */
  sourceQ?: number;
}

/** Разобранный JSON ассета. Читается ради `extensionsUsed` — остальное не наше дело. */
interface AssetJson {
  extensionsUsed?: string[];
  [key: string]: unknown;
}
import { decodeKtx2 } from './ktx2-decode.mjs';
import { instanceStatic, unbakeCopies } from './instance.mjs';
import { type Ceiling, probeWebpCeiling, readCeiling, targetQuality } from './source-quality.mjs';
import { readSourceJson } from './source-json.mjs';
import { importNote } from './import-notes.mjs';
import { scanLods } from './lod-scan.mjs';
import { readInteractivity } from './interactivity.mjs';
import { collectMetrics, countTriangles, effectiveSkins, listSemantics, textureSize } from './metrics.mjs';
import { HAS_GLTF_CLI, TOKTX, runCli } from './tools.mjs';
import { hasOpaqueExtension } from './carry.mjs';

// Раздел текстур на «данные» и «цвет». Нормали, occlusion и roughness — это ЧИСЛА,
// закодированные картинкой, а не картинка: у них нет цветности, которую можно
// незаметно огрубить. Поэтому оба текстурных правила обращаются с ними бережнее —
// KTX2 даёт им UASTC вместо ETC1S (ETC1S мылит нормали и делает ступеньки на
// roughness), WebP — lossless вместо обычного (лоссовый WebP режет цветность 4:2:0
// и портит вектор нормали). Общее место, потому что раздел один и тот же: разъедутся
// — модели начнут по-разному портиться в зависимости от выбранной галочки.
// Regex и glob обязаны совпадать по смыслу: первый читает наш код, второй — toktx.
const DATA_SLOT_RE = /normal|occlusion|roughness/i;
const DATA_SLOT_GLOB = '*{normal,Normal,occlusion,Occlusion,metallicRoughness,Roughness}*';

/**
 * Качество WebP, когда потолок исходника узнать НЕЧЕМ (KTX2 и всё незнакомое).
 *
 * Ровно прежнее поведение правила — жёсткий q90. Держится отдельной константой, потому
 * что это не расчёт, а признание незнания: правило обязано сказать о нём вслух строкой
 * `webp.ceilingUnknown`, а не подставить число молча.
 */
const WEBP_UNKNOWN_CEILING = 90;

/**
 * Отказы транскодера KTX2, у которых есть строка в каталоге.
 *
 * Список, а не проверка «начинается на ktx2.»: подставлять в отчёт ключ, которого в
 * каталоге нет, — то же самое, что подставлять голый токен, только медленнее. Появится
 * новый отказ в ktx2-decode.mts — его надо добавить и сюда, и в оба каталога; сторож
 * ключей-сирот в tests/engine-contract об этом напомнит.
 */
const KTX2_REASONS = new Set([
  'ktx2.invalid',
  'ktx2.hdr',
  'ktx2.multiface',
  'ktx2.transcodeStart',
  'ktx2.transcodeFailed',
  'ktx2.decodeFailed',
]);

/**
 * Умолчание ползунка качества.
 *
 * Сто (Александр, 2026-08-17, посмотрев результат: «рекомендованные 90 портят уже сильно
 * модель. пусть изначально ползунок просто будет на 100»). Кратко была попытка поставить
 * 90 ради прежней лёгкости — на глаз она оказалась слишком дорогой, и это тот случай,
 * когда смотрят, а не считают.
 *
 * Сотня НЕ означает «без потерь» для лоссового исходника, и обещать этого нельзя. Замер
 * `_work/generation-loss.mjs` на ABeautifulGame: перекодирование JPEG q83 в WebP q83 даёт
 * RMSE 1.7…6.2, и убрать это нечем — запас по качеству почти не помогает (при +15 всё ещё
 * 5.6 при тройном весе), отключение прореживания цветности тоже (5.95). Ноль даёт только
 * режим без потерь, и он для той же текстуры вчетверо тяжелее исходника. Два лоссовых
 * кодека по-разному раскладывают картинку — второй честно кодирует артефакты первого.
 * Для исходника БЕЗ потерь сотня действительно означает ноль потерь.
 */
const WEBP_QUALITY_DEFAULT = 100;

/**
 * Доля от качества исходника: 0…100.
 *
 * Значение приходит с ползунка и через API; чужое, поэтому проверяется здесь, а не на
 * входе. Мусор («abc», null) откатывается к рекомендуемому, числа за краями зажимаются.
 */
function webpShare(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return WEBP_QUALITY_DEFAULT;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// Текстура «цветная» (данные в sRGB), если так сказала сама модель — ребро графа
// помечено isColor, — ИЛИ если имя слота содержит color/emissive.
//
// Второй признак нужен потому, что расширения объявляют isColor не всегда:
// KHR_materials_diffuse_transmission не помечает им `diffuseTransmissionColorTexture`,
// а это настоящая цветная карта.
//
// А вот проверять «имя содержит diffuse», как это делает getTextureColorSpace() из
// @gltf-transform/functions (SRGB_PATTERN = /color|emissive|diffuse/i), нельзя:
// `diffuseTransmissionTexture` — скалярный коэффициент пропускания, линейный по
// спецификации расширения. Из-за одного слова «diffuse» в имени он утягивал в sRGB
// всю карту, а в этой модели тем же изображением служат ещё occlusion и
// metallicRoughness. Результат — AO и шероховатость, декодированные как sRGB:
// на глаз модель темнее оригинала.
const COLOR_SLOT_RE = /color|emissive/i;

function isColorTexture(tex: Texture, listSlots: (tex: Texture) => string[]): boolean {
  const declared = tex.getGraph().listParentEdges(tex).some((e: { getAttributes: () => { isColor?: boolean } }) => e.getAttributes().isColor);
  return declared || COLOR_SLOT_RE.test(listSlots(tex).join(' '));
}

// KTX2: сместить transfer function на линейную у текстур, которые цветными не являются.
//
// Кодировщик получает цветовое пространство от gltf-transform CLI и записывает его в
// DFD (Data Format Descriptor) готового файла. Пиксели при этом НЕ пересчитываются:
// toktx вызывается с --assign-oetf, то есть проставляет ярлык. Поэтому исправить
// достаточно ярлык — перекодировать нечего.
//
// Раскладка KTX2 (спецификация Khronos, §3.1 и §3.9): по смещению 48 лежит
// dfdByteOffset; в самом DFD после dfdTotalSize (u32) и двух служебных u32 идут
// colorModel, colorPrimaries, transferFunction, flags — по байту.
const KTX2_DFD_OFFSET_POS = 48;
const KHR_DF_PRIMARIES_UNSPECIFIED = 0;
const KHR_DF_TRANSFER_LINEAR = 1;
const KHR_DF_TRANSFER_SRGB = 2;

function relabelDataTextures(document: Document, functions: TextureSlotFns, out: { details: Message[] }): void {
  const relabeled = [];
  for (const tex of document.getRoot().listTextures()) {
    if (tex.getMimeType() !== 'image/ktx2') continue;
    if (isColorTexture(tex, functions.listTextureSlots)) continue;

    const image = tex.getImage();
    if (!image || image.byteLength < KTX2_DFD_OFFSET_POS + 4) continue;
    const buf = new Uint8Array(image); // копия: правим не чужой буфер
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dfd = view.getUint32(KTX2_DFD_OFFSET_POS, true);
    const transferPos = dfd + 14;
    if (!dfd || transferPos >= buf.length) continue;
    if (buf[transferPos] !== KHR_DF_TRANSFER_SRGB) continue;

    buf[transferPos] = KHR_DF_TRANSFER_LINEAR;
    buf[dfd + 13] = KHR_DF_PRIMARIES_UNSPECIFIED; // первичные цвета к линейным данным неприменимы
    tex.setImage(buf);
    relabeled.push(tex.getName() || functions.listTextureSlots(tex).join('+') || '—');
  }
  if (relabeled.length) {
    out.details.push({ messageId: 'ktx2.relabeled', data: { n: relabeled.length, list: relabeled.join(', ') } });
  }
}

// Расширения, объявленные в файле, но неизвестные библиотеке.
//
// Зачем это правилам. Неизвестное расширение библиотека при загрузке просто отбрасывает
// — по документу его уже не видно. А оно могло описывать данные, которые держатся на
// ИНДЕКСАХ свойств: `KHR_animation_pointer` адресует анимируемое свойство путём вида
// `/materials/2/pbrMetallicRoughness/baseColorFactor`. После разбора такой канал теряет
// цель, любая чистка считает его ничьим и удаляет, а перенумерация свойств (дедупликация,
// объединение) ломает уцелевшие пути.
//
// Замер 2026-07-31 на `AnimationPointerUVs.glb` (образец Khronos): без флажков анимация
// проходит насквозь целой (1 → 1), с одним `safe` исчезает (1 → 0) и валидатор Khronos
// выдаёт 6 новых ошибок. Сторож целостности это ловит и метит файл красным, но это
// защита от последствий, а не отказ их причинять.
//
// Список берём из САМОГО файла: в GLB он лежит в JSON-чанке, в .gltf это обычный JSON.
const KNOWN_EXTENSIONS = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

// Своего читателя здесь больше нет. Прежний вычитывал файл ЦЕЛИКОМ — и у .glb тоже,
// хотя нужен один чанк: на модели в 41 МБ это было 41 лишний мегабайт через память за
// каждый прогон. Соседний модуль умел правильно с самого начала, просто про него не
// знали (сведено 2026-08-22).
const readAssetJson = (srcPath: string): AssetJson | null => readSourceJson(srcPath) as AssetJson | null;

// Результат кэшируется в ctx.cache: файл читают несколько правил, а он может весить
// сотни мегабайт.
// Разобранный JSON ИСХОДНОГО файла — один раз на прогон, на всех желающих.
//
// Желающих стало двое (2026-08-15): сторож незнакомых расширений и наблюдение за
// уровнями детализации. Оба смотрят на первоисточник, а не на документ (EXTENDING §5c),
// и оба читали файл сами — а он бывает в сотни мегабайт. Заодно это единственное место,
// где разбор исходника имеет право сорваться молча: файл не читается — этим займётся
// сама загрузка, правилам тут сказать нечего.
function assetJson(ctx: GltfContext): AssetJson | null {
  const KEY = 'assetJson';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as AssetJson | null;
  let json: AssetJson | null;
  try {
    json = ctx.src ? readAssetJson(ctx.src) : null;
  } catch {
    json = null; // файл не разобрался — этим займётся сама загрузка, здесь молчим
  }
  if (ctx.cache) ctx.cache.set(KEY, json);
  return json;
}

function unsupportedExtensions(ctx: GltfContext): string[] {
  const KEY = 'unsupportedExtensions';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as string[];
  const json = assetJson(ctx);
  const list = ((json && json.extensionsUsed) || []).filter((name: string) => !KNOWN_EXTENSIONS.has(name));
  if (ctx.cache) ctx.cache.set(KEY, list);
  return list;
}

/**
 * Незнакомые расширения, ЧЬИ АДРЕСА НЕЛЬЗЯ СУЗИТЬ, — только они опасны для правил,
 * которые лишь ДОБАВЛЯЮТ элементы в массивы (сварка добавляет аксессор).
 *
 * Заведено 2026-08-27. Разбор — в шапке `carry.mts`; коротко: расширение с адресами-
 * строками (`KHR_animation_pointer` → `/materials/0/...`) видно насквозь, и сварка ему
 * не мешает; расширение со ссылками числами (`MSFT_lod`, `KHR_interactivity`) —
 * непрозрачно, и любой сдвиг может его сломать.
 */
function opaqueUnsupported(ctx: GltfContext): string[] {
  const KEY = 'opaqueUnsupported';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY) as string[];
  const list = hasOpaqueExtension(assetJson(ctx), unsupportedExtensions(ctx));
  if (ctx.cache) ctx.cache.set(KEY, list);
  return list;
}

/** Отказ для правил, которые массивы только ДОПОЛНЯЮТ, а не перетасовывают. */
function refuseIfOpaque(ctx: GltfContext): FixDecision | null {
  const list = opaqueUnsupported(ctx);
  if (!list.length) return null;
  return { safe: false, messageId: 'unsupportedExtension.refuse', data: { list: list.join(', '), n: list.length } };
}

// Готовый отказ для правил, которые переставляют или удаляют свойства. Общий, чтобы
// причина у всех была одна и та же — человек должен увидеть одно объяснение, а не пять
// разных формулировок одной беды.
function refuseIfUnsupported(ctx: GltfContext): FixDecision | null {
  const list = unsupportedExtensions(ctx);
  if (!list.length) return null;
  return { safe: false, messageId: 'unsupportedExtension.refuse', data: { list: list.join(', '), n: list.length } };
}

// Чистка не имеет права унести ВСЮ сцену.
//
// Найдено 2026-08-04, когда в корпус добавили представителей класса «модель без
// геометрии» (`Empty Nodes 01`, `Two Scenes 01`): узел без меша для prune() —
// «лист без содержимого», и на модели, где мешей нет вовсе, чистка удаляла все узлы
// до единого. Дальше срабатывал сторож целостности, объявлял `boundsChanged` и
// файл не писался — то есть человека спасали, но причину называли не ту: границы
// изменились не сами, их обнулила чистка.
//
// Такие модели существуют не в теории: сцена из локаторов, пустой риг, экспорт, где
// геометрия не выгрузилась. Правильный ответ — не трогать её и сказать почему, а не
// разобрать и упереться в проверку.
function refuseIfWouldEmptyScene(ctx: GltfContext): FixDecision | null {
  const root = ctx.document.getRoot();
  const nodes = root.listNodes();
  if (!nodes.length) return null;
  const hasDrawable = nodes.some((n: Node) => n.getMesh() || n.getCamera());
  if (hasDrawable) return null;
  return { safe: false, messageId: 'prune.refuse.wouldEmptyScene', data: { n: nodes.length } };
}

// Меши, на которые ссылается больше одного узла, — общая геометрия.
//
// Отличать её от обычной приходится по факту, а не по замыслу автора модели: связанные
// дубликаты Blender (Alt+D) дают её сразу, обычные копии (Ctrl+D) — после дедупликации,
// когда побайтно одинаковые меши сведены в один. Для объединения мешей это единственное,
// что важно: такой меш нельзя запечь в вершины, не размножив его на каждого владельца.
function sharedMeshes(document: Document): Set<Mesh> {
  const shared = new Set<Mesh>();
  for (const mesh of document.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users++;
      if (users > 1) { shared.add(mesh); break; }
    }
  }
  return shared;
}

// Меши, чьи примитивы участвуют в переключении вариантов материала.
//
// KHR_materials_variants хранит подмену НА ПРИМИТИВЕ: «этот кусок при варианте
// „Carmine Candy“ берёт материал 7, при „Torched Graphite“ — материал 12». Объединение
// сливает примитивы, и вместе с ними исчезает место, где подмена записана.
//
// Замер 2026-08-15 на CarConcept (3 окраски машины, 25 примитивов, 75 привязок): после
// flatten+join примитивов остаётся 23, привязок — НОЛЬ. При этом сам список вариантов
// живёт в корне документа и никуда не девается — то есть файл продолжает заявлять три
// окраски, не содержа ни одной. Это хуже честной потери: программа на сайте покажет
// человеку выбор из трёх цветов, который ничего не переключает.
//
// Проверяется по факту наличия расширения на примитиве, а не по объявлению в корне:
// объявление переживает объединение и потому ни о чём не говорит.
function variantMeshes(document: Document): Set<Mesh> {
  const kept = new Set<Mesh>();
  for (const mesh of document.getRoot().listMeshes()) {
    if (mesh.listPrimitives().some((p) => p.getExtension('KHR_materials_variants'))) kept.add(mesh);
  }
  return kept;
}

// ============================================================================
// СКИННИНГ: общая механика трёх правил, которые чинят замечания валидатора Khronos
// (сделаны 2026-08-12). Здесь только чтение и запись влияний костей; что именно
// считать дефектом — дело самих правил.
//
// Почему это отдельный блок, а не три копии обхода. Все три правила ходят по одним и
// тем же данным (JOINTS_n/WEIGHTS_n), и разойдись обходы — разойдётся и понимание того,
// что такое «вершина» в модели с восемью влияниями.
// ============================================================================

/** Пара аксессоров одного набора влияний: JOINTS_n и WEIGHTS_n. */
interface SkinSet {
  joints: Accessor;
  weights: Accessor;
}

// Наборы влияний примитива по порядку n. Спецификация glTF 2.0 (§3.7.3.2) требует, чтобы
// JOINTS_n и WEIGHTS_n шли парами и нумеровались подряд с нуля, поэтому первая же дырка
// заканчивает список. Пустой массив — примитив не скиннутый, таких большинство.
function skinSets(prim: Primitive): SkinSet[] {
  const out: SkinSet[] = [];
  for (let n = 0; ; n++) {
    const joints = prim.getAttribute(`JOINTS_${n}`);
    const weights = prim.getAttribute(`WEIGHTS_${n}`);
    if (!joints || !weights) break;
    out.push({ joints, weights });
  }
  return out;
}

// Обход всех скиннутых вершин документа — по одному разу на НАБОР аксессоров, а не на
// примитив. Один и тот же JOINTS_0 бывает у нескольких примитивов (общая геометрия), и
// без этой проверки его вершины считались бы дважды: работа идемпотентна и вреда бы не
// было, но число в отчёте оказалось бы вдвое больше правды.
function forEachSkin(document: Document, visit: (sets: SkinSet[], vertices: number) => void): void {
  const ids = new Map<object, number>();
  const idOf = (o: object): number => {
    let id = ids.get(o);
    if (id === undefined) { id = ids.size; ids.set(o, id); }
    return id;
  };
  const seen = new Set<string>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const sets = skinSets(prim);
      if (!sets.length) continue;
      const key = sets.map((s) => `${idOf(s.joints)}:${idOf(s.weights)}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      visit(sets, sets[0]!.joints.getCount());
    }
  }
}

// Размеры уменьшенной картинки: большая сторона равна цели, меньшая считается по
// пропорции и округляется до кратного ЧЕТЫРЁМ.
//
// Почему четырём — замер 2026-08-12 (вопрос Александра про нестандартные размеры).
// 1500×1200 при цели 1024 даёт по пропорции 1024×819. Отказа от кодека нет, но `toktx`
// молча делает из 819 — 820: KTX2/Basis кодирует блоками 4×4. Получалось, что ОДИН
// выбор человека давал два разных файла — 819 без KTX2 и 820 с ним. Округляем сами:
// результат один при любом наборе флажков, и число в отчёте совпадает с файлом.
//
// Пропорция при этом уезжает меньше чем на четверть процента (819 → 820 это 0,12 %) —
// на глаз этого нет. А вот менять пропорцию ЗАМЕТНО (приводить обе стороны к степени
// двойки) нельзя: UV модели рассчитаны на исходное соотношение, и рисунок растянулся бы
// на самой модели.
//
// Цели (512/1024/2048/4096) кратны четырём сами, поэтому округляется только меньшая
// сторона. Увеличить она не может: результат ограничен исходным размером.
function fitInside(width: number, height: number, target: number): [number, number] {
  const scale = target / Math.max(width, height);
  const snap = (value: number, limit: number) => Math.max(1, Math.min(limit, Math.round(value / 4) * 4));
  if (width >= height) return [target, snap(height * scale, height)];
  return [snap(width * scale, width), target];
}

// Потолок нормализованного целого. Веса разрешено хранить и во float (5126), и
// нормализованными ubyte/ushort — у последних запись это округление value × MAX.
const NORMALIZED_MAX: Record<number, number> = { 5121: 255, 5123: 65535 };

function normalizedMaxOf(acc: Accessor): number | null {
  if (!acc.getNormalized()) return null;
  return NORMALIZED_MAX[acc.getComponentType()] ?? null;
}

// Записать доли вершины так, чтобы сумма осталась единицей И ПОСЛЕ записи.
//
// Во float достаточно поделить на сумму. С нормализованными целыми деления мало:
// три доли по 1/3 запишутся как 85+85+85 = 255 (повезло), а 0.7 и 0.3 — как 179+77 = 256
// (не повезло), и валидатор пожалуется снова, теперь уже на нашу работу. Поэтому для
// целых доли считаются В ЦЕЛЫХ методом наибольших остатков, а обратно кладётся ровно
// k/MAX — обратное преобразование вернёт то самое k, без сюрпризов округления.
function writeNormalizedWeights(sets: SkinSet[], index: number, rows: number[][], sum: number): void {
  const max = normalizedMaxOf(sets[0]!.weights);
  if (max === null) {
    for (let s = 0; s < sets.length; s++) {
      sets[s]!.weights.setElement(index, rows[s]!.map((v) => v / sum));
    }
    return;
  }

  // Плоский список долей: границы наборов для дележа значения не имеют, вершина одна.
  const flat: number[] = [];
  for (const row of rows) for (const v of row) flat.push(v);

  const exact = flat.map((v) => (v / sum) * max);
  const ints = exact.map((v) => Math.floor(v));
  let rest = max - ints.reduce((a, b) => a + b, 0);
  // Остаток раздаётся тем, у кого дробная часть больше, — по единице. Так расхождение с
  // точным значением у каждой доли меньше одного шага квантования.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) ints[order[k]!.i]! += 1;

  let at = 0;
  for (let s = 0; s < sets.length; s++) {
    const row = rows[s]!.map(() => ints[at++]! / max);
    sets[s]!.weights.setElement(index, row);
  }
}

// Веса вершины одним плоским списком плюс их сумма. Наборов может быть несколько
// (WEIGHTS_0 и WEIGHTS_1 — это восемь влияний на вершину), и сумма считается по ВСЕМ:
// требование спецификации предъявлено к вершине, а не к отдельному аксессору.
function readWeights(sets: SkinSet[], index: number, rows: number[][]): number {
  let sum = 0;
  for (let s = 0; s < sets.length; s++) {
    const row = rows[s]!;
    row.length = 0;
    sets[s]!.weights.getElement(index, row);
    for (const v of row) sum += v;
  }
  return sum;
}

// Узел без собственного преобразования. Сравнение точное, без допуска: «почти
// единичное» преобразование — это уже пересчёт сцены, а правило обещает доказуемость.
function isIdentityNode(node: Node): boolean {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  return t[0] === 0 && t[1] === 0 && t[2] === 0
    && r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 1
    && s[0] === 1 && s[1] === 1 && s[2] === 1;
}

/** Узлы, у которых хоть один канал анимации меняет преобразование. */
function animatedNodes(document: Document): Set<Node> {
  const out = new Set<Node>();
  for (const anim of document.getRoot().listAnimations()) {
    for (const channel of anim.listChannels()) {
      const target = channel.getTargetNode();
      if (target) out.add(target);
    }
  }
  return out;
}

/** Заготовки строк под наборы влияний — чтобы не выделять массив на каждую вершину. */
function rowsFor(sets: SkinSet[]): number[][] {
  return sets.map(() => []);
}

// Допуск на сумму влияний — во float, потому что четыре-восемь сложений float32 дают
// расхождение в последних битах, и гоняться за ним значит переписывать веса всей модели
// ради нуля разницы. 1e-6 на два порядка больше шума и на пять порядков меньше того, что
// валидатор называет ошибкой (замер: 0.86 при ожидаемой единице).
const WEIGHT_SUM_EPS = 1e-6;

// Сумма влияний уже единица? Вопрос задаётся в том виде хранения, в каком лежат данные, —
// иначе ответ разойдётся с валидатором. У нормализованных целых единица это ТОЧНОЕ
// равенство суммы целых потолку (255 или 65535): 0.5 + 0.5 во float безупречны, а в
// ubyte это 128 + 128 = 256, то есть перебор на один шаг, и файл невалиден.
function weightsAreUnit(sets: SkinSet[], rows: number[][], sum: number): boolean {
  const max = normalizedMaxOf(sets[0]!.weights);
  if (max === null) return Math.abs(sum - 1) <= WEIGHT_SUM_EPS;
  let ints = 0;
  for (const row of rows) for (const v of row) ints += Math.round(v * max);
  return ints === max;
}

// Настройки квантования, безопасные для ОБЩЕГО скина (TESTBUG-007).
//
// Область квантования по умолчанию — 'mesh': своя сетка на каждый меш, а значит своё
// компенсирующее преобразование. У скинованного меша трансформация узла по спецификации
// glTF ИГНОРИРУЕТСЯ, поэтому компенсация обязана лечь в inverseBindMatrices — а они
// принадлежат скину. Несколько мешей с разными областями требуют нескольких наборов IBM,
// и общий скин расщепляется: 1 → 14 (замер на parkergirl). 'scene' даёт одну область на
// всю сцену → одно преобразование → один набор IBM, скин остаётся общим.
//
// Общее место для всех правил, которые квантуют геометрию: разойдутся — модель начнёт
// по-разному расщепляться в зависимости от выбранной галочки.
function quantizeOptions(document: Document): { quantizationVolume?: 'scene' } {
  return document.getRoot().listSkins().length > 0 ? { quantizationVolume: 'scene' } : {};
}

/** Исход попытки обработать ОДИН элемент: успех со значением либо причина отказа. */
type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

// Одна точка, где сбой ОДНОГО элемента превращается в результат, а не в обрыв прогона
// (находка 2 ревью 2026-08-15). Правило, которое обрабатывает текстуры по одной, обязано
// переживать отказ одной битой картинки; обёртка ловит и возвращает «не удалось», а что
// с этим делать — счётчик, имя, откат — решает само правило. Структурный сторож —
// tests/architecture/rule-resilience.test.mjs: новых catch-блоков в fix() быть не должно.
async function attempt<T>(fn: () => Promise<T> | T): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as { message?: string } | null | undefined;
    return { ok: false, reason: (err && err.message) || String(e) };
  }
}

// Порядок пайплайна ЖЁСТКИЙ и выверен в v2 (кодируется через runAfter):
// dedup → prune → vertex-colors → skin-joints-dedupe → skin-weights-normalize →
// skin-zero-weight-joints → weld → degenerate → orphan → (flatten+join)
// → prune → ktx2 → geometry-compress. Не менять.
//
// Три правила скиннинга вставлены 2026-08-12 между цветами и сваркой. Место выбрано не
// свободным: чистка влияний обязана пройти ДО weld и до сжатия геометрии, иначе
// кодек закрепит мусор, а сварка не сведёт вершины, которые стали одинаковыми только
// после чистки. Прежняя цепочка сохранена целиком — новый участок вложен внутрь неё.
export const RULES: GltfRule[] = [
  {
    // Уровни детализации: правило БЕЗ починки, только наблюдение.
    //
    // MSFT_lod вешает на узел список запасных, менее подробных версий; какую показать,
    // решает движок по тому, сколько места объект занимает на экране. Загрузчик three.js
    // расширение игнорирует и рисует самый подробный уровень — то есть КАРТИНКА У НАС
    // ВЕРНАЯ, чинить нечего. Не хватало только слова: человек не знал, что в файле есть
    // ещё уровни и что показан из них один.
    //
    // ВТОРОЙ И ТРЕТИЙ СЛУЧАЙ (2026-08-28). Расширение экспортируют единицы. Куда чаще
    // уровни лежат просто соседними узлами: у Sketchfab подписанными «LOD», у прочих не
    // подписанными никак. Их отчёт не видел вовсе — при том что переключатель уровней
    // над моделью для них уже появлялся. Один вопрос — два разных ответа в двух местах,
    // ровно то, что запрещают Правила интерфейса §1. Слово Александра прямое: «надо что
    // бы в правой панели тоже показывало».
    //
    // Решение принимает `core/lod-grouping.mts` — тот же модуль, что и во вьюпорте.
    // Здесь только повод его спросить.
    //
    // Создание уровней в задачи проекта не входит (Александр, 2026-08-15), поэтому здесь
    // нет и не будет `fix`. Правило существует ради одной строки в «Анализе».
    meta: {
      id: 'scene/lod-levels', category: 'scene', title: 'Levels of detail', titleKey: 'rule.sceneLodLevels',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true, // наблюдение, а не оптимизация: не зависит ни от одной галочки
    },
    analyze(ctx) {
      // ── Способ первый: расширение. Это ФАКТ, и он старше любой догадки. ──────────
      //
      // Читаем ИСХОДНЫЙ файл, а не документ: gltf-transform про MSFT_lod не знает, и в
      // документе расширения нет вовсе (docs/EXTENDING.md §5c — истина в первоисточнике).
      // Через общий assetJson: тот же файл читает сторож незнакомых расширений, а весит
      // он бывает сотни мегабайт.
      const json = assetJson(ctx);
      if (json && (json.extensionsUsed || []).includes('MSFT_lod')) {
        // Считаем УЗЛЫ с уровнями и максимальную глубину списка, а не сумму по всем
        // узлам: «в файле 47 уровней» ничего не значит, а «у 12 частей до 3» — значит.
        let nodes = 0;
        let deepest = 0;
        for (const node of (json.nodes || []) as Array<{ extensions?: Record<string, { ids?: unknown[] }> }>) {
          const ids = node.extensions?.['MSFT_lod']?.ids;
          if (!Array.isArray(ids) || !ids.length) continue;
          nodes++;
          // +1 — сам узел: он и есть самый подробный уровень, список перечисляет запасные.
          deepest = Math.max(deepest, ids.length + 1);
        }
        // Одна запись на класс (Правило 9): узлов бывают десятки, строка одна.
        if (nodes) return [{ messageId: 'lod.found', data: { nodes, levels: deepest } }];
      }

      // ── Способы второй и третий: соседние узлы. Это ДОГАДКА, и говорим о ней так. ─
      //
      // Разные сообщения на две догадки, а не одно с подстановкой: разница между
      // «автор подписал» и «мы измерили» — это разный вес утверждения, и склеивать их
      // одной строкой с переменной значило бы прятать её (Правило 8 §3).
      const found = scanLods(ctx.document);
      if (!found) return [];
      const data = { nodes: found.nodes, levels: found.levels };
      // Ключи названы ПРЯМО, а не выбраны тернарником в поле messageId. Сторож
      // ключей-сирот (tests/engine-contract.test.mjs, раздел 3) читает исходник и ищет
      // это поле вместе с ключом в кавычках; вычисленное имя он не видит, и оба ключа
      // повисли бы сиротами в каталогах. Поймано полным прогоном 2026-08-28 — и поймано
      // по делу: ключ, которого не видно в коде, не найдёт и человек.
      //
      // Образец ключа в комментарий не вписывать: тот же разбор прочтёт его как ссылку
      // из кода и потребует такой ключ в каталоге. На этом сторож покраснел второй раз,
      // уже на объяснении самого себя.
      if (found.source === 'names') return [{ messageId: 'lod.likelyNames', data }];
      return [{ messageId: 'lod.likelyMeasured', data }];
    },
  },

  {
    // Интерактив: правило БЕЗ починки, только наблюдение.
    //
    // ЗАКАЗ (Александр, 2026-08-28): «я не вижу вообще никаких интерактивов. должен
    // видеть». До этого дня про интерактив в отчёте было ровно пять строк, и все пять — в
    // «Пропущено», где расширение называлось «тем, которого этот конвейер не понимает».
    // Человек узнавал только это: у него в файле что-то, чего мы не умеем.
    //
    // Теперь он узнаёт то, что действительно важно: интерактив В ФАЙЛЕ ЕСТЬ, вот сколько
    // его, и он доезжает целым. Числа человеческие — на что нажать, сколько откликов,
    // что происходит, — а не «узлов графа 595».
    //
    // ПРОИГРЫВАНИЯ ЗДЕСЬ НЕТ И НЕ БУДЕТ без отдельного решения: граф поведения исполняет
    // интерпретатор, это работа другого размера (§6д ROADMAP). Правило ЧИТАЕТ и НАЗЫВАЕТ.
    meta: {
      id: 'scene/interactivity', category: 'scene', title: 'Interactivity', titleKey: 'rule.sceneInteractivity',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true, // наблюдение, а не оптимизация: не зависит ни от одной галочки
    },
    analyze(ctx) {
      const found = readInteractivity(assetJson(ctx));
      if (!found) return [];
      const { clickable, handlers, animations, changes, silent } = found;
      // Запуск анимации и смена свойства — для человека одно и то же: «что-то
      // происходит». Раздельные числа давали в строке нули (у Calculator анимаций нет
      // вовсе), а ноль в перечислении читается как поломка, а не как факт.
      // Одна запись на класс (Правило 9): узлов графа бывают сотни, строка одна.
      //
      // Две строки на два случая, а не одна с подстановкой. Модель, где нажимать не на
      // что, — это другое утверждение, а не то же с нулём: у неё интерактив работает сам
      // (по времени, по загрузке), и обещать человеку кнопки было бы враньём.
      const actions = animations + changes;
      const out: Finding[] = [];
      if (clickable) out.push({ messageId: 'interactivity.found', data: { clickable, handlers, actions } });
      else out.push({ messageId: 'interactivity.foundNoClicks', data: { handlers, actions } });
      // Отдельная строка на отдельное утверждение, и появляется она только когда есть о
      // чём говорить. Пустая часть — это не «подробность про интерактив», а расхождение
      // между обещанием и файлом: обведена, а откликнуться нечем.
      if (silent) out.push({ messageId: 'interactivity.silentParts', data: { n: silent } });
      return out;
    },
  },

  {
    // НАБЛЮДЕНИЕ, а не оптимизация. Отвечает на вопрос «что мы приложили к модели из
    // того, что лежало рядом» — и отвечать обязано ВСЛУХ.
    //
    // Пару «эта модель + эти карты» составил человек, когда бросил их вместе, поэтому
    // Правило 11 не нарушено. Но раскладку по слотам предложили МЫ, прочитав имена
    // файлов, — а предложенное за человека он должен видеть. Молчаливое назначение было
    // бы решением за него, и разницы с редактором не осталось бы никакой.
    meta: {
      id: 'import/textures-attached', category: 'scene', title: 'Textures picked up from neighbouring files', titleKey: 'rule.importTexturesAttached',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true,
    },
    analyze(ctx) {
      const note = importNote(ctx.document);
      if (!note || !note.attached.length) return [];
      // Здесь строка НА КАЖДУЮ карту, и это не нарушение Правила 9. Схлопывать нечего:
      // слоты разные, файлы разные, и «приложено 6 карт» не даёт человеку проверить,
      // не села ли шероховатость в слот металличности. Список сам и есть суть находки —
      // ровно то исключение, которое правило называет.
      // Имена слотов выписаны ЛИТЕРАЛАМИ, а не собраны шаблоном `slot.${a.slot}`. Так их
      // видит статический сканер сторожа ключей-сирот: собранный на лету ключ он прочесть
      // не может, и шесть честных имён повисли бы мусором. Ровно та же ошибка уже была
      // сделана с metric.* в core/contract.mts — и поймана тем же сторожем.
      const SLOT_NAME = {
        baseColor: { messageId: 'slot.baseColor', data: {} },
        normal: { messageId: 'slot.normal', data: {} },
        roughness: { messageId: 'slot.roughness', data: {} },
        metallic: { messageId: 'slot.metallic', data: {} },
        occlusion: { messageId: 'slot.occlusion', data: {} },
        emissive: { messageId: 'slot.emissive', data: {} },
      } as Record<string, { messageId: string; data: Record<string, unknown> }>;
      return note.attached.map((a) => ({
        messageId: 'import.textureAttached',
        data: { slot: SLOT_NAME[a.slot] ?? a.slot, file: a.file },
      }));
    },
  },

  {
    // НАБЛЮДЕНИЕ, а не оптимизация: ни canFix, ни fix, и появиться они не должны.
    // Правило отвечает на один вопрос — что из привезённого файла НЕ доехало.
    //
    // Молчание здесь было бы худшим видом вранья. Человек бросил FBX с анимацией,
    // получил .glb без неё и не узнал бы об этом ниоткуда: модель открывается, меши на
    // месте, валидатор доволен. То же с текстурой, которую файл НАЗЫВАЕТ, а рядом её не
    // положили: материал выйдет серым, и это будет выглядеть как наша работа, хотя это
    // правда о поставке.
    meta: {
      id: 'import/not-carried', category: 'scene', title: 'Not carried over from the source', titleKey: 'rule.importNotCarried',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true, // наблюдение не зависит ни от одной галочки
    },
    analyze(ctx) {
      const note = importNote(ctx.document);
      if (!note) return []; // файл приехал не из FBX — говорить не о чем

      // Одна запись на КЛАСС случаев, а не на элемент (Правило 9): недостающих карт
      // бывает десяток, а строка про них одна. Имена не перечисляем — хватает счёта;
      // исключение сделано для единственной, где имя и есть вся суть находки.
      const out: Finding[] = [];
      if (note.missingTextures.length) {
        out.push(note.missingTextures.length === 1
          ? { messageId: 'import.textureMissing', data: { name: note.missingTextures[0]! } }
          : { messageId: 'import.textureMissing.many', data: { n: note.missingTextures.length } });
      }
      if (note.animations) out.push({ messageId: 'import.animationsDropped', data: { n: note.animations } });
      if (note.skins) out.push({ messageId: 'import.skinsDropped', data: { n: note.skins } });
      return out;
    },
  },

  {
    // Морф-цели, которые никто не двигает: правило БЕЗ починки, только наблюдение.
    //
    // Морф-цель — запасная форма меша: улыбка, прищур, вмятина. Двигают их дорожки
    // анимации по каналу `weights`. Бывает, что цели в файле есть, а дорожек нет вовсе:
    // тогда в любом просмотрщике видна нейтральная поза, и со стороны это неотличимо от
    // модели без морфов. Замер по корпусу 2026-08-15: Morph Cube 01 — две названные цели,
    // ни одной дорожки; у parkergirl целей 456 и все анимированы.
    //
    // Почему только строка, без ползунков в интерфейсе (решение Александра, 2026-08-15):
    // у настоящих файлов имён у целей нет (проверено — у parkergirl и chibi_zenitsu ноль
    // имён), и панель выдала бы «Морф 1 … Морф 456» — ровно ту толпу одинаковых строк,
    // которую запрещает Правило 9.
    //
    // Чинить нечего и не надо: морф-цель — замысел автора (Правило 11). Мы её считаем и
    // охраняем метрикой morphTargets, а тут просто называем вслух.
    meta: {
      id: 'scene/morph-targets', category: 'scene', title: 'Morph targets', titleKey: 'rule.sceneMorphTargets',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: [],
      reversible: true, dataLoss: 'none',
      enabled: () => true, // наблюдение, а не оптимизация: не зависит ни от одной галочки
    },
    analyze(ctx) {
      const root = ctx.document.getRoot();

      // Считаем МЕШИ с целями и максимум целей на примитив, а не сумму по файлу:
      // «в файле 456 целей» ничего не значит, а «у 8 частей до 57 форм» — значит.
      let meshes = 0;
      let deepest = 0;
      for (const mesh of root.listMeshes()) {
        let most = 0;
        for (const prim of mesh.listPrimitives()) most = Math.max(most, prim.listTargets().length);
        if (!most) continue;
        meshes++;
        deepest = Math.max(deepest, most);
      }
      if (!meshes) return [];

      // Двигает ли их хоть одна дорожка. В gltf-transform канал веса — это путь
      // 'weights' у Channel; сам канал знает и цель, и путь.
      let animated = false;
      for (const anim of root.listAnimations()) {
        if (anim.listChannels().some((ch) => ch.getTargetPath() === 'weights')) { animated = true; break; }
      }

      // Одна запись на класс (Правило 9): мешей бывают десятки, строка одна.
      return [{
        messageId: animated ? 'morph.found.animated' : 'morph.found.still',
        data: { meshes, forms: deepest },
      }];
    },
  },

  {
    meta: {
      id: 'structure/dedup', category: 'materials', title: 'Duplicate resources (dedup)', titleKey: 'rule.structureDedup',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: [], touches: ['texture', 'material', 'accessor'],
      reversible: false, dataLoss: 'none', // склеиваются только байт-в-байт идентичные копии — терять нечего
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    // Дедупликация сводит одинаковые свойства в одно и перенумеровывает остальные —
    // ровно то, чего не переживают ссылки по индексу из неизвестного нам расширения.
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'dedup.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      await ctx.document.transform(fns.dedup());
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, acc: root.listAccessors().length };
      const out: { found: Message[]; details: Message[] } = { found: [], details: [] };
      if (b.tex > a.tex) { out.found.push({ messageId: 'dedup.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'dedup.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'dedup.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'dedup.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.acc > a.acc) { out.found.push({ messageId: 'dedup.found.accessors', data: { n: b.acc - a.acc } }); out.details.push({ messageId: 'dedup.done.accessors', data: { n: b.acc - a.acc } }); }
      return out;
    },
  },

  {
    meta: {
      id: 'structure/prune-unused', category: 'scene', title: 'Unused resources (prune)', titleKey: 'rule.structurePruneUnused',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/dedup'], touches: ['texture', 'material', 'accessor', 'node'],
      reversible: false, dataLoss: 'none', // удаляется только то, на что нет ни одной ссылки
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    // Чистка удаляет то, на что «нет ссылок». Ссылку из неизвестного расширения она не
    // видит — и уносит вместе с мусором живые данные (замер: анимация 1 → 0).
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || refuseIfWouldEmptyScene(ctx) || { safe: true, messageId: 'prune.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      // Разворачивать оговорку «а вдруг человек приложит карты потом» здесь НЕ НАДО.
      // Пробовал 2026-08-22 — Александр поправил: «если загружается модель с юви, но нет
      // текстур и мы прогоняем через оптимизацию, так и должно быть, что удаляется юви
      // канал». Он прав: развёртка без единой карты — мёртвый груз, и хранить её значит
      // возить байты, которые ничего не показывают.
      //
      // Случай «карты приложили рядом» закрывается сам и раньше: подбор соседних карт
      // (import-textures.mts) идёт на ВВОЗЕ, до правил. К этому месту текстура уже
      // привязана к материалу, материал ссылается на развёртку — и чистка её не тронет.
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out: { found: Message[]; details: Message[] } = { found: [], details: [] };
      // Одна строка на ВСЕ убранные атрибуты, а не строка на каждый. Восемь неиспользуемых
      // UV-каналов давали восемь одинаковых по смыслу записей, различавшихся только
      // именем канала. Схлопывать их в интерфейсе нельзя честно: он видит готовые строки
      // и, сложив их в «TEXCOORD_1 … ×8», называет один канал, а имеет в виду восемь.
      // Правило знает весь список сразу — здесь это и есть правильное место.
      const removedSem = [...semBefore].filter((s) => !semAfter.has(s)); // listSemantics отдаёт Set
      if (removedSem.length === 1) {
        out.found.push({ messageId: 'prune.found.attribute', data: { sem: removedSem[0] } });
        out.details.push({ messageId: 'prune.done.attribute', data: { sem: removedSem[0] } });
      } else if (removedSem.length > 1) {
        const data = { n: removedSem.length, list: removedSem.join(', ') };
        out.found.push({ messageId: 'prune.found.attributes', data });
        out.details.push({ messageId: 'prune.done.attributes', data });
      }
      if (b.tex > a.tex) { out.found.push({ messageId: 'prune.found.textures', data: { n: b.tex - a.tex } }); out.details.push({ messageId: 'prune.done.textures', data: { n: b.tex - a.tex } }); }
      if (b.mat > a.mat) { out.found.push({ messageId: 'prune.found.materials', data: { n: b.mat - a.mat } }); out.details.push({ messageId: 'prune.done.materials', data: { n: b.mat - a.mat } }); }
      if (b.skins > a.skins && b.effSkins === a.effSkins) {
        // удалены только пустышки: действующих скинов не убыло (иначе инвариант остановит запись)
        out.found.push({ messageId: 'prune.found.emptySkins', data: { n: b.skins - a.skins } });
        out.details.push({ messageId: 'prune.done.emptySkins', data: { n: b.skins - a.skins } });
      }
      return out;
    },
  },

  {
    meta: {
      // tier basic: базовое действие — удаление БЕЛЫХ каналов (provable, вид не меняется).
      // Lossy-ветка (удалить раскрашенные) — расширение 'strip-colors': включается только
      // через advancedFeatures:['strip-colors'] или флаг --strip-vertex-colors (→ opts.stripColors).
      id: 'attributes/vertex-colors', category: 'attributes', title: 'Vertex colors (COLOR_n)', titleKey: 'rule.attributesVertexColors',
      // numeric, а не provable (ревью 2026-08-10, P1.5). «Белый» здесь определяется с
      // допуском 0.999, то есть 0.9995 объявляется единицей. Разницы не видно, но это
      // уже не строгое математическое равенство, а по нашей же терминологии — numeric.
      // На то, применится ли правило, это не влияет: потолок автофикса perceptual.
      severity: 'warn', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      // базовая ветка (белые каналы) — потери нет; strip-ветка помечает свои строки
      // через res.irreversible → dataLoss 'significant' на уровне applied-записи
      reversible: false, dataLoss: 'none',
      // белая-чистка входит в safe; удаление раскрашенных — флажок strip-colors (внутри fix)
      enabled: (o) => o.safe || o.stripColors,
    },
    // Детекция при применении, а не в analyze: COLOR-каналы, которые снесёт prune
    // (например неиспользуемый COLOR_1), не должны попадать в находки — v2 сканировал
    // ПОСЛЕ prune, сохраняем то же окно измерения.
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      // белый (все значения 1.0) → provable: множитель baseColor равен единице.
      // раскрашенный → lossy: убирается только явным флагом (решение внутри fix).
      return { safe: true, messageId: 'vertexColors.safe', data: {} };
    },
    fix(finding, ctx) {
      // Аннотация нужна: пустой массив без неё выводится как never[], и push в него —
      // ошибка. Необязательные каналы (irreversible, cost) объявлены здесь же, потому
      // что правило наполняет их условно, уже после создания объекта.
      const out: FixOut = { found: [], skipped: [], details: [] };
      const el: number[] = [];
      // Копим по атрибуту, а не отчитываемся на каждом меше: семь мешей с белым COLOR_0 —
      // это одна находка про семь мешей, а не семь находок. Ключ — сам атрибут (COLOR_0
      // и COLOR_1 смешивать нельзя) и то, что с ним решили сделать.
      const buckets = new Map<string, { sem: string; kind: string; meshes: string[] }>(); // `${sem}|${kind}` → { sem, kind, meshes: [] }
      const note = (sem: string, kind: string, meshName: string) => {
        const key = `${sem}|${kind}`;
        if (!buckets.has(key)) buckets.set(key, { sem, kind, meshes: [] });
        buckets.get(key)!.meshes.push(meshName);
      };
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc!.getCount();
            for (let i = 0; i < n; i++) {
              acc!.getElement(i, el); // нормализованные float-значения
              if (el.some((v: number) => v < 0.999)) { allWhite = false; break; }
            }
            const meshName = mesh.getName() || '—';
            if (allWhite) {
              prim.setAttribute(sem, null);
              note(sem, 'white', meshName);
            } else if (ctx.opts.stripColors) {
              prim.setAttribute(sem, null); // lossy, но пользователь явно форсировал флагом
              note(sem, 'stripped', meshName);
            } else {
              note(sem, 'painted', meshName);
            }
          }
        }
      }
      // Один меш — прежние сообщения с именем; несколько — множественные со списком.
      // Отдельные ключи, а не склейка списка в те же строки: «меш Cube.014, Cube.017»
      // на другом языке потребует другого слова и другого порядка.
      for (const b of buckets.values()) {
        const one = b.meshes.length === 1;
        const data = one
          ? { sem: b.sem, mesh: b.meshes[0] }
          : { sem: b.sem, n: b.meshes.length, list: b.meshes.join(', ') };
        const id = (base: string) => (one ? base : `${base}.many`);
        if (b.kind === 'white') {
          out.found.push({ messageId: id('vertexColors.found.white'), data });
          out.details.push({ messageId: id('vertexColors.done.white'), data });
        } else if (b.kind === 'stripped') {
          out.found.push({ messageId: id('vertexColors.found.painted'), data });
          // Раскрашенные цвета удалены по явной просьбе — данные исчезли, и запись об
          // этом обязана нести свой ярлык, а не наследовать «numeric» у правила.
          // Раньше наследовала, и разрушительное действие отчитывалось как безопасное.
          out.irreversibleSafety = 'lossy';
          (out.irreversible ??= []).push({ messageId: id('vertexColors.stripped'), data });
        } else {
          out.found.push({ messageId: id('vertexColors.found.painted'), data });
          out.skipped.push({ messageId: id('vertexColors.skipped'), data });
        }
      }
      return out;
    },
  },

  {
    meta: {
      // Одна и та же кость записана в вершину дважды. Валидатор:
      // ACCESSOR_JOINTS_INDEX_DUPLICATE. Починка — сложить доли в первое вхождение,
      // второе обнулить: сумма влияний на вершину не меняется НИ НА СКОЛЬКО, поэтому
      // provable, а не numeric. Матрица кости одна и та же, складывать её доли законно.
      id: 'skin/joints-dedupe', category: 'geometry', title: 'Duplicate joint per vertex', titleKey: 'rule.skinJointsDedupe',
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['accessor'],
      reversible: false, dataLoss: 'none', // складываем доли одной и той же кости — данных не убыло
      enabled: (o) => o.safe || o.compress, // чистка влияний нужна и перед сжатием (§5b1)
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinJoints.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let vertices = 0;
      let merged = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const jrows = rowsFor(sets);
        const wrows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          for (let s = 0; s < sets.length; s++) {
            jrows[s]!.length = 0;
            sets[s]!.joints.getElement(i, jrows[s]!);
            wrows[s]!.length = 0;
            sets[s]!.weights.getElement(i, wrows[s]!);
          }
          // Плоский обход: дубль ищется по всей вершине, а не внутри одного набора —
          // кость может стоять и в JOINTS_0, и в JOINTS_1.
          const firstAt = new Map<number, [number, number]>();
          let touched = false;
          for (let s = 0; s < sets.length; s++) {
            for (let c = 0; c < jrows[s]!.length; c++) {
              const joint = jrows[s]![c]!;
              const weight = wrows[s]![c]!;
              // Место с нулевой долей — НАБИВКА, а не влияние: у вершины, которую двигает
              // одна кость, остальные три места заняты нулями, и все три ссылаются на
              // кость 0. Считать их повторами значит объявить дефектом обычную запись
              // (замер 2026-08-12: 49 124 «повтора» на chibi_zenitsu там, где валидатор
              // видит ровно два). Пустыми местами занимается skin/zero-weight-joints.
              if (weight === 0) continue;
              const seen = firstAt.get(joint);
              if (seen === undefined) { firstAt.set(joint, [s, c]); continue; }
              // Дубль: доля уезжает в первое вхождение, здесь остаётся пустое место.
              // Индекс тоже обнуляется — иначе на его месте останется кость с нулевым
              // весом, то есть следующее замечание валидатора вместо этого.
              wrows[seen[0]]![seen[1]] = wrows[seen[0]]![seen[1]]! + weight;
              wrows[s]![c] = 0;
              jrows[s]![c] = 0;
              merged++;
              touched = true;
            }
          }
          if (!touched) continue;
          for (let s = 0; s < sets.length; s++) {
            sets[s]!.joints.setElement(i, jrows[s]!);
            sets[s]!.weights.setElement(i, wrows[s]!);
          }
          vertices++;
        }
      });

      // Одна запись на класс, а не на вершину: дублей бывают тысячи (Правило 9).
      if (vertices) {
        out.found.push({ messageId: 'skinJoints.found.duplicate', data: { n: vertices, joints: merged } });
        out.details.push({ messageId: 'skinJoints.done.duplicate', data: { n: vertices, joints: merged } });
      }
      return out;
    },
  },

  {
    meta: {
      // Сумма влияний на вершину не равна единице. Валидатор:
      // ACCESSOR_WEIGHTS_NON_NORMALIZED. Починка — поделить доли на их сумму.
      //
      // numeric, а не provable, и это честно: числа МЕНЯЮТСЯ. Но меняются в ту сторону,
      // которую автор модели и имел в виду: шейдер скиннинга веса не нормализует, он
      // просто складывает взвешенные матрицы, — при сумме 0.86 вершина стягивалась к
      // началу координат на 14 %. То есть правило чинит видимый глазом дефект, а не
      // приводит файл в порядок ради валидатора.
      id: 'skin/weights-normalize', category: 'geometry', title: 'Skin weights normalization', titleKey: 'rule.skinWeightsNormalize',
      severity: 'warn', fixSafety: 'numeric', tier: 'basic', runAfter: ['skin/joints-dedupe'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinWeights.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let fixed = 0;
      let zeroSum = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const rows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          const sum = readWeights(sets, i, rows);
          // Вершина без единого влияния — ИЛИ сумма, которую мы не понимаем: отрицательная
          // (файл уже невалиден иначе) или NaN (битый accessor). `!(sum > 0)` вместо
          // `sum <= 0` — тот же случай нуля, но ещё и NaN, у которого ЛЮБОЕ сравнение с
          // числом ложно, включая `<= 0`. Без этой формы NaN проходил бы дальше: в ветке
          // с нормализованными целыми Math.round(NaN) при записи в Uint16Array тихо
          // становится нулём (влияние молча исчезает, без единой строки в отчёте), а во
          // float-ветке NaN так и остаётся NaN в файле — новый дефект вместо старого.
          // Делить не на что, а выдумать ей кость мы не вправе: какая именно должна
          // двигать эту вершину, знает только автор модели.
          if (!(sum > 0)) { zeroSum++; continue; }
          if (weightsAreUnit(sets, rows, sum)) continue;
          writeNormalizedWeights(sets, i, rows, sum);
          fixed++;
        }
      });

      if (fixed) {
        out.found.push({ messageId: 'skinWeights.found', data: { n: fixed } });
        out.details.push({ messageId: 'skinWeights.done', data: { n: fixed } });
      }
      // Вершины без влияний — не наша работа и не наша вина; сказать о них надо, но
      // одной строкой на все, а не строкой на вершину.
      if (zeroSum) out.skipped.push({ messageId: 'skinWeights.skipped.zeroSum', data: { n: zeroSum } });
      return out;
    },
  },

  {
    meta: {
      // Кость записана в вершину с нулевым весом. Валидатор (предупреждение):
      // ACCESSOR_JOINTS_USED_ZERO_WEIGHT. Починка — обнулить индекс: на отрисовку он не
      // влияет никак (вес ноль), а файл после этого и сжимается лучше — столбец из
      // одинаковых нулей кодек берёт почти даром.
      //
      // Счёт идёт ДЕСЯТКАМИ ТЫСЯЧ на обычном персонаже (замер 2026-08-12: 57 551 на
      // chibi_zenitsu, 79 398 на Lilith). Отсюда жёсткое требование Правила 9: это ОДНА
      // строка про десятки тысяч, а не десятки тысяч строк.
      id: 'skin/zero-weight-joints', category: 'geometry', title: 'Joints referenced with zero weight', titleKey: 'rule.skinZeroWeightJoints',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['skin/weights-normalize'], touches: ['accessor'],
      reversible: false, dataLoss: 'none', // вес нулевой — кость не влияла ни на что
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'skinZeroJoints.safe', data: {} }; },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      let cleared = 0;
      let vertices = 0;

      forEachSkin(ctx.document, (sets, count) => {
        const jrows = rowsFor(sets);
        const wrows = rowsFor(sets);
        for (let i = 0; i < count; i++) {
          let touched = false;
          for (let s = 0; s < sets.length; s++) {
            jrows[s]!.length = 0;
            sets[s]!.joints.getElement(i, jrows[s]!);
            wrows[s]!.length = 0;
            sets[s]!.weights.getElement(i, wrows[s]!);
            for (let c = 0; c < jrows[s]!.length; c++) {
              if (wrows[s]![c] !== 0 || jrows[s]![c] === 0) continue;
              jrows[s]![c] = 0;
              cleared++;
              touched = true;
            }
          }
          if (!touched) continue;
          for (let s = 0; s < sets.length; s++) sets[s]!.joints.setElement(i, jrows[s]!);
          vertices++;
        }
      });

      if (cleared) {
        out.found.push({ messageId: 'skinZeroJoints.found', data: { n: cleared, vertices } });
        out.details.push({ messageId: 'skinZeroJoints.done', data: { n: cleared, vertices } });
      }
      return out;
    },
  },

  {
    meta: {
      // Узел со скиннутым мешем не в корне сцены. Валидатор (предупреждение):
      // NODE_SKINNED_MESH_NON_ROOT — «преобразования родителей на скиннутый меш не
      // подействуют». Это предупреждение о НЕДОПОНИМАНИИ автора модели, а не поломка
      // файла: по спецификации glTF 2.0 (§3.6.3) преобразование узла со скином
      // игнорируется, положение задаёт скелет, и все движки ведут себя тут одинаково.
      //
      // Поэтому чинится только ДОКАЗУЕМОЕ подмножество (§5b1): у узла нет детей, его
      // собственное преобразование единичное, и вся цепочка родителей до сцены —
      // единичная и неанимированная. Тогда перенос в корень не меняет в сцене ни одного
      // числа, а предупреждение исчезает. Всё остальное — настоящий пересчёт (перенос
      // преобразования родителя внутрь матриц обратной привязки), и он здесь не делается
      // ни при каких флажках: правило откажется и скажет, почему.
      id: 'scene/skinned-mesh-root', category: 'scene', title: 'Skinned mesh outside the scene root', titleKey: 'rule.sceneSkinnedMeshRoot',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['skin/zero-weight-joints'], touches: ['node'],
      reversible: false, dataLoss: 'none', // переставляется ссылка, данные не трогаются
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) {
      // Та же причина, что у остальных структурных правил: неизвестное расширение может
      // адресовать узлы по номеру, а перестановка эти номера меняет.
      return refuseIfUnsupported(ctx) || { safe: true, messageId: 'skinnedRoot.safe', data: {} };
    },
    fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const root = ctx.document.getRoot();
      const animated = animatedNodes(ctx.document);
      let moved = 0;
      let refused = 0;

      for (const node of root.listNodes()) {
        if (!node.getSkin() || !node.getMesh()) continue;
        const parent = node.getParentNode();
        if (!parent) continue; // уже в корне — валидатору не на что жаловаться

        // Дети уехали бы вместе с узлом, а их-то преобразования родителя как раз
        // касаются. Собственное преобразование единичное — требование §5b1.
        let provable = !node.listChildren().length && isIdentityNode(node);
        let top: Node = parent;
        for (let p: Node | null = parent; p && provable; p = p.getParentNode()) {
          top = p;
          // Анимированный родитель единичен только в позе покоя. Само по себе это
          // скиннутому мешу безразлично (его преобразование игнорируется), но проверить
          // это утверждение нечем, кроме спецификации, — а правило обещает доказуемость.
          if (!isIdentityNode(p) || animated.has(p)) provable = false;
        }
        if (!provable) { refused++; continue; }

        const scene = root.listScenes().find((s) => s.listChildren().includes(top));
        if (!scene) { refused++; continue; } // узел вне сцены — не наше дело

        parent.removeChild(node);
        scene.addChild(node);
        moved++;
      }

      // По одной строке на класс: узлов бывает полтора десятка (замер: 14 на parkergirl).
      if (moved) {
        out.found.push({ messageId: 'skinnedRoot.found', data: { n: moved } });
        out.details.push({ messageId: 'skinnedRoot.done', data: { n: moved } });
      }
      if (refused) out.skipped.push({ messageId: 'skinnedRoot.skipped.notProvable', data: { n: refused } });
      return out;
    },
  },

  {
    meta: {
      id: 'geometry/weld', category: 'geometry', title: 'Vertex weld', titleKey: 'rule.geometryWeld',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['skin/zero-weight-joints'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // свариваются только идентичные вершины
      // geometry-чистка идёт и при компрессии: спека Draco — «decode → run all geometry
      // optimizations → encode». Без неё draco роняет вырожденные треугольники на записи →
      // расхождение с checkpoint. Поэтому safe ИЛИ compress.
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    // ОТКАЗ НА НЕПРОЗРАЧНОМ РАСШИРЕНИИ — добавлен 2026-08-27, и это не осторожность впрок,
    // а починка измеренной потери.
    //
    // ЧТО БЫЛО. `Unknown Ext Interactivity 01` приходил с графом поведения:
    //   "extensions": { "KHR_interactivity": { "graphs": [ … ], "graph": 0 } }
    // и уходил С ПУСТЫМ ТЕЛОМ при сохранённом имени в `extensionsUsed`. То есть файл
    // заявлял способность, которой у него больше не было, — ровно то враньё, которого
    // боится разбор в шапке `restoreCarried` («приклеить расширение к чужому объекту
    // хуже, чем потерять его: файл выглядел бы целым и врал»).
    //
    // ПОЧЕМУ ИМЕННО ЗДЕСЬ. Замер: на passthrough не сдвигается НИЧЕГО и расширение
    // доезжает целым; на `safe` сдвигаются `accessors 1→2` и `bufferViews 1→2`. Прибавку
    // даёт сварка — она добавляет аксессор. А `arraysAddressedBy` для графа поведения
    // возвращает `null` («не знаю, на что смотрит»), и тогда сверяются ВСЕ массивы;
    // сдвинувшийся `accessors` и отменял восстановление.
    //
    // Из шести правил, меняющих длины массивов, отказ стоял у пяти — dedup, prune,
    // skinnedRoot, join, pruneFinal. Weld был единственным без него, и по нему утекало.
    //
    // ОТКАЗ УЖЕ, ЧЕМ У СОСЕДЕЙ, И ЭТО НАМЕРЕННО. Сварка массивы только ДОПОЛНЯЕТ, а не
    // перетасовывает, поэтому ей хватает `refuseIfOpaque`: расширение с адресами-строками
    // (KHR_animation_pointer) видно насквозь и сварке не мешает. Широкий отказ ломал бы
    // прежнее решение, записанное тестом golden-corpus: «Неструктурные правила (weld)
    // по-прежнему работают» на AnimationPointerUVs. Проверено: с широким отказом тот тест
    // краснеет, с узким — зелёный, а расширения всё равно доезжают целыми.
    //
    // ЦЕНА НАЗВАНА ЧЕСТНО: модель с незнакомым расширением больше не сваривается, то
    // есть оптимизируется слабее. Это осознанный размен, и он в ту же сторону, что
    // Правило 11: сохранность замысла автора выше выигрыша в байтах. Человек узнаёт о
    // пропуске из отчёта — сообщение `unsupportedExtension.refuse` называет расширение.
    canFix(finding, ctx) { return refuseIfOpaque(ctx) || { safe: true, messageId: 'weld.safe', data: {} }; },
    async fix(finding, ctx) {
      // точка отсчёта для инварианта «треугольники не изменились» — как в v2:
      // после prune/цветов, до сварки (weld порождает вырожденные треугольники)
      ctx.cache.set('trianglesBeforeWeld', countTriangles(ctx.document));
      let vb = 0, va = 0;
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) vb += pos.getCount(); }
      await ctx.document.transform(fns.weld());
      for (const m of ctx.document.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); if (pos) va += pos.getCount(); }
      if (vb > va) {
        return { found: [{ messageId: 'weld.found', data: { n: vb - va } }], details: [{ messageId: 'weld.done', data: { before: vb, after: va } }] };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/degenerate-triangles', category: 'geometry', title: 'Degenerate triangles', titleKey: 'rule.geometryDegenerate',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/weld'], touches: ['geometry'],
      reversible: false, dataLoss: 'none', // нулевая площадь — не рисовались
      enabled: (o) => o.safe || o.compress, // чистка геометрии нужна и перед компрессией
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'degenerate.safe', data: {} }; },
    fix(finding, ctx) {
      // Вырожденный треугольник — тот, у которого два угла стоят в ОДНОЙ ТОЧКЕ. Площадь
      // нулевая, видеокарта не закрашивает ни одного пикселя, на картинке его нет.
      //
      // Совпадение бывает двух видов, и до 2026-08-22 мы ловили только первый:
      //
      //   1. ОДИН И ТОТ ЖЕ индекс дважды в тройке. Это порождает сам weld: он склеивает
      //      одинаковые вершины, и треугольник, у которого две вершины были одинаковы,
      //      схлопывается в отрезок.
      //   2. РАЗНЫЕ индексы, но одинаковая позиция. Weld такие НЕ склеивает: у вершин
      //      различаются нормаль или развёртка, и как вершины они разные. А как углы
      //      треугольника — одна точка.
      //
      // Второй вид пропускался, и его находил уже кодировщик Draco: он выбрасывает такие
      // треугольники сам, на записи. Отсюда брался испуг в отчёте — «нарушение гарантии
      // компонента», хотя ничего не ломалось. ЗАМЕР 2026-08-22 по 61 настоящей модели:
      // теряли треугольники 15 штук, и потеря СОВПАДАЛА с числом вырожденных до единицы
      // (Whatsminer 17560 из 116399, «Ноутбук» 8420, Е300 405 = 213 по индексам + 192 по
      // позициям). От числа бит квантования потеря не зависит — значит дело не в сетке
      // кодека, а в этих самых треугольниках. Убрали их здесь — Draco не теряет ничего.
      //
      // Считаем ПОСЛЕ weld (он порождает первый вид). Итог меряем дельтой по сцене:
      // правка общего аксессора действует на все его инстансы.
      const trisBefore = countTriangles(ctx.document);
      const prims = [];
      const shareCount = new Map<object, number>();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue; // только TRIANGLES
          const indices = prim.getIndices();
          if (!indices) continue;
          prims.push(prim);
          shareCount.set(indices, (shareCount.get(indices) || 0) + 1);
        }
      }
      const patched = new Set();
      for (const prim of prims) {
        const indices = prim.getIndices()!;
        // Позиции читаем на КАЖДЫЙ примитив: совпадение точек — свойство его вершин, а не
        // индексов. Общий индексный аксессор у примитивов с разными вершинами — законная
        // разметка, и резать его по чужим позициям нельзя (ниже он для этого клонируется).
        const pos = prim.getAttribute('POSITION');
        const p = pos ? pos.getArray() : null;
        // Морфы: вершина, стоящая в одной точке с соседней в базовой позе, под морфом
        // расходится — треугольник оживает. Такие не трогаем, только повтор индекса.
        const morphed = prim.listTargets().length > 0;
        const joints = prim.getAttribute('JOINTS_0');
        const weights = prim.getAttribute('WEIGHTS_0');
        // Скин: то же самое, но расхождение даёт не морф, а кость. Совпадение позиций
        // считается только когда обе вершины привязаны одинаково — тогда они и в анимации
        // останутся одной точкой.
        const rigSame = (a: number, b: number): boolean => {
          for (const acc of [joints, weights]) {
            if (!acc) continue;
            const arr = acc.getArray();
            if (!arr) continue;
            const n = acc.getElementSize();
            for (let c = 0; c < n; c++) if (arr[a * n + c] !== arr[b * n + c]) return false;
          }
          return true;
        };
        const onePoint = (a: number, b: number): boolean => {
          if (a === b) return true;
          if (!p || morphed) return false;
          if (p[a * 3] !== p[b * 3] || p[a * 3 + 1] !== p[b * 3 + 1] || p[a * 3 + 2] !== p[b * 3 + 2]) return false;
          return rigSame(a, b);
        };
        // Аксессор, общий с другим примитивом, режется ТОЛЬКО по повторяющемуся индексу —
        // этот признак от вершин не зависит и у всех совладельцев одинаков. Всё остальное
        // требует своей копии, иначе рез по позициям одного примитива выкосит треугольники
        // у другого, у которого те же индексы указывают на другие точки.
        const sharedAccessor = (shareCount.get(indices) || 1) > 1;
        // `!` вместо проверок: getArray() у аксессора с индексами непустой — сюда
        // не доходят примитивы без индексов (см. проверку выше). Конструктор берётся
        // у самого массива, чтобы сохранить его тип (Uint16Array/Uint32Array), —
        // приведение нужно только компилятору, в собранном коде его нет.
        const arr = indices.getArray()!;
        const out: number[] = [];
        let cutByPosition = false;
        for (let i = 0; i + 2 < arr.length; i += 3) {
          const a = arr[i]!, b = arr[i + 1]!, c = arr[i + 2]!;
          if (a === b || b === c || a === c) continue;
          if (onePoint(a, b) || onePoint(b, c) || onePoint(a, c)) { cutByPosition = true; continue; }
          out.push(a, b, c);
        }
        if (out.length === arr.length) { patched.add(indices); continue; }
        if (sharedAccessor && cutByPosition) {
          // Своя копия — чужие примитивы с тем же аксессором остаются как были.
          const own = indices.clone();
          own.setArray(new (arr.constructor as Uint32ArrayConstructor)(out));
          prim.setIndices(own);
          continue;
        }
        if (patched.has(indices)) continue; // общий аксессор не режем дважды
        indices.setArray(new (arr.constructor as Uint32ArrayConstructor)(out));
        patched.add(indices);
      }
      const sceneRemoved = trisBefore - countTriangles(ctx.document);
      ctx.cache.set('degenerateRemoved', sceneRemoved); // для инварианта по треугольникам
      if (sceneRemoved > 0) {
        return {
          found: [{ messageId: 'degenerate.found', data: { n: sceneRemoved } }],
          details: [{ messageId: 'degenerate.done', data: { n: sceneRemoved } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'geometry/orphan-vertices', category: 'geometry', title: 'Orphan vertices', titleKey: 'rule.geometryOrphan',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['geometry/degenerate-triangles'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // не адресованы индексами — не рисовались
      enabled: (o) => o.safe || o.compress, // чистка геометрии нужна и перед компрессией
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (typeof fns.compactPrimitive !== 'function') {
        return { safe: false, messageId: 'orphan.unavailable', data: {} };
      }
      return { safe: true, messageId: 'orphan.safe', data: {} };
    },
    fix(finding, ctx) {
      let before = 0;
      let after = 0;
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          if (!pos || !prim.getIndices()) continue;
          before += pos.getCount();
          fns.compactPrimitive(prim);
          after += prim.getAttribute('POSITION')!.getCount();
        }
      }
      if (before > after) {
        return {
          found: [{ messageId: 'orphan.found', data: { n: before - after } }],
          details: [{ messageId: 'orphan.done', data: { n: before - after } }],
        };
      }
      return {};
    },
  },

  {
    meta: {
      id: 'scene/join', category: 'scene', title: 'Mesh join (flatten + join)', titleKey: 'rule.sceneJoin',
      // runAfter включает scene/instance НАМЕРЕННО, и это не косметика порядка.
      // Инстансированные узлы несут EXT_mesh_gpu_instancing, и join их не трогает —
      // то есть instance, отработав первым, физически защищает общую геометрию от
      // разворачивания в копии. Обратный порядок стоил бы на ABeautifulGame +84 %.
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['geometry/orphan-vertices', 'scene/instance'], touches: ['geometry', 'node'],
      reversible: false, dataLoss: 'significant', // §4d: структура узлов и имена частей теряются безвозвратно
      reversalNoteKey: 'reversal.join',
      feature: 'join', // отдельный флажок (структурно, необратимо)
      enabled: (o) => o.join,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'join.safe', data: {} }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      const b = m();

      // УМНОЕ ОБЪЕДИНЕНИЕ: сливаем только то, что сливается без потерь.
      //
      // Объединение запекает трансформ узла прямо в вершины, поэтому меш, на который
      // ссылаются восемь узлов, обязан превратиться в восемь по-разному повёрнутых
      // копий. На модели, построенной на повторах, это удваивало вес файла ради
      // экономии отрисовок — размен, которого никто не просил.
      //
      // Раньше от этого спасал только инстансинг: он вешает на узел
      // EXT_mesh_gpu_instancing, а такие узлы join не трогает. Спасал не всегда:
      // общая геометрия появляется и ПОСРЕДИ прогона — дедупликация в `safe` сводит
      // побайтно одинаковые меши в один, и модель с обычными копиями (Ctrl+D в Blender)
      // становится моделью с общей геометрией уже после того, как интерфейс решил,
      // предлагать инстансинг или нет. Замер 2026-07-31: `Unlinked Duplicates 01`
      // с флажками по умолчанию рос на 61 %, единственный такой на весь корпус.
      //
      // Теперь общая геометрия исключается из объединения по факту, на месте: узел с
      // мешем, у которого больше одного пользователя, join не получает вовсе. Своей
      // логики объединения мы не пишем — это штатная опция filter самой библиотеки.
      // Второе исключение из объединения — варианты материала (см. variantMeshes).
      // Причина у него другая, чем у общей геометрии: там объединение РАЗМНОЖАЕТ
      // данные, здесь — СТИРАЕТ их. Оба случая решаются одним и тем же штатным
      // фильтром библиотеки, поэтому собираются в один набор.
      await ctx.document.transform(fns.flatten());
      const shared = sharedMeshes(ctx.document);
      const variants = variantMeshes(ctx.document);
      const spared = new Set([...shared, ...variants]);
      await ctx.document.transform(fns.join({ filter: (node) => !spared.has(node.getMesh()!) }));

      const a = m();

      // Оставленная общая геометрия — не молчаливый отказ: человек видит меньше
      // сэкономленных отрисовок, чем ожидал, и должен знать, почему и что включить.
      const keptShared = shared.size
        ? [{ messageId: 'join.keptShared', data: { meshes: shared.size } }]
        : [];
      // То же и про варианты: цена сохранённого выбора цветов — несколько лишних
      // отрисовок, и назвать её человек имеет право. Одна строка на класс (Правило 9),
      // а не строка на каждый уцелевший меш.
      const keptVariants = variants.size
        ? [{ messageId: 'join.keptVariants', data: { meshes: variants.size } }]
        : [];

      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        const details = [{ messageId: 'join.done', data: { dcBefore: b.drawCalls, dcAfter: a.drawCalls, nodesBefore: b.nodes, nodesAfter: a.nodes } }];
        // Здесь была строка «объединение размножило общую геометрию: +N байт».
        // Убрана 2026-08-01 как ложная в обе стороны (TESTBUG-009):
        //
        //  1. Размножить общую геометрию join больше НЕ МОЖЕТ — общие меши
        //     исключены фильтром выше и до объединения не доходят. На Dirty Cube
        //     сообщение выпадало при shared.size === 0, то есть называло причиной
        //     то, чего не происходило.
        //  2. Рост измерялся в окне самого transform-а, а сразу за join идёт
        //     structure/prune-final и временные копии убирает. Замер 2026-08-01:
        //     геометрия 2648 → 1880 байт, то есть на треть МЕНЬШЕ, — а строка в
        //     это время сообщала «+960 байт (+36 %)».
        //
        // Настоящую цену человек видит в общем итоге сборки (было → стало), а
        // почему сэкономлено меньше отрисовок, чем он ждал, объясняет join.keptShared.
        return { found: [{ messageId: 'join.found', data: { drawCalls: b.drawCalls, nodes: b.nodes } }], details, skipped: [...keptShared, ...keptVariants] };
      }
      return { skipped: [...keptShared, ...keptVariants] };
    },
  },

  {
    meta: {
      // GPU-инстансинг: повторяющиеся меши → EXT_mesh_gpu_instancing (меньше draw calls).
      // Отдельный флажок; расширение требует поддержки декодера на целевом сайте.
      id: 'scene/instance', category: 'scene', title: 'GPU instancing', titleKey: 'rule.sceneInstance',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['node', 'mesh'],
      reversible: true, dataLoss: 'none',
      reversalNoteKey: 'reversal.instance',
      feature: 'instance',
      enabled: (o) => o.instance,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      // min: 2, а не библиотечные 5.
      //
      // Порог решает не только «стоит ли овчинка выделки», но и КОГО инстансинг
      // защитит от scene/join: инстансированный узел несёт EXT_mesh_gpu_instancing,
      // и join его уже не трогает. Меш, переиспользованный 2–4 раза, при пороге 5
      // оставался незащищённым — и join разворачивал его в отдельные копии.
      //
      // Замерено 2026-07-31 на всех 34 моделях корпуса (dedup → instance → flatten →
      // join): min 2 не хуже min 5 НИГДЕ и заметно лучше на трёх. ABeautifulGame —
      // +20 % против −14 % при одинаковых 15 draw calls, то есть 34 процентных пункта
      // из-за одной цифры; Dirty Cube 01 −5 % → −11 %; MosquitoInAmber2 −2 % → −9 %.
      // На остальных 31 результат совпал байт в байт.
      // СВОЙ проход, а не fns.instance(). Разница ровно одна и она принципиальная:
      // библиотека отказывается инстансить файл, в котором есть ХОТЬ ОДНА анимация, где
      // бы та ни сидела. Александр 2026-08-23: «ведь анимируются не детали на которых
      // инстансинги. тогда почему отказывается делать инстанс?». Наша граница поузловая —
      // разбор и остальные сохранённые запреты в шапке `instance.mts`.
      // СНАЧАЛА РАСПЕКАЕМ КОПИИ, разъехавшиеся по вершинам, и только потом инстансим.
      //
      // Александр 2026-08-23: «это одинаковые кубы. мы никак не можем начать их тоже
      // инстансить? если человек пришлёт такую же модель мы не сможем понять что это
      // одинаковые модели никак?». Можем: модификатор Array в Blender запекает смещение
      // в координаты, и одинаковые кубы приезжают разными мешами. Разбор — в шапке
      // `instance.mts`; геометрия при этом не переписывается ни на число.
      const unbaked = unbakeCopies(ctx.document);
      const res = instanceStatic(ctx.document, { min: 2 });
      const a = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      if (res.batches > 0) {
        const details: Message[] = [
          { messageId: 'instance.done', data: { dcBefore: b.dc, dcAfter: a.dc, nodesBefore: b.nodes, nodesAfter: a.nodes } },
        ];
        // Про распекание говорим ОТДЕЛЬНОЙ строкой и только когда оно было: человек
        // вправе знать, что копии узнаны не по ссылке, а по форме. Одна строка на весь
        // класс, а не на каждый меш (Правило 9).
        if (unbaked.merged) {
          details.push({ messageId: 'instance.unbaked', data: { n: unbaked.merged, groups: unbaked.groups } });
        }
        return { found: [{ messageId: 'instance.found', data: {} }], details };
      }
      // ПРИЧИНА ОТКАЗА НАЗЫВАЕТСЯ ВЕРНАЯ. Раньше здесь стояла одна строка на все случаи —
      // «повторяющихся мешей нет», — и на анимированной модели она была ложью: меши могли
      // повторяться сколько угодно, а отказала библиотека совсем по другому поводу.
      // Правило 12 разрешает не делать действие, только если объяснить почему; неверное
      // объяснение хуже молчания, потому что человек по нему принимает решения.
      return {
        skipped: [{
          messageId: res.animatedSkipped ? 'instance.skipped.animated' : 'instance.skipped.nothing',
          data: { n: res.animatedSkipped },
        }],
      };
    },
  },

  {
    meta: {
      // Ресэмпл анимаций: убрать избыточные ключевые кадры (без потерь качества).
      id: 'animation/resample', category: 'performance', title: 'Resample animations', titleKey: 'rule.animationResample',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
      reversible: false, dataLoss: 'none',
      feature: 'resample',
      enabled: (o) => o.resample,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      if (!root.listAnimations().length) return { skipped: [{ messageId: 'resample.skipped.noAnimations', data: {} }] };
      const bytes = () => root.listAccessors().reduce((s, a) => { const arr = a.getArray(); return s + (arr ? arr.byteLength : 0); }, 0);
      const before = bytes();
      await ctx.document.transform(fns.resample());
      const after = bytes();
      if (after < before) return { details: [{ messageId: 'resample.done', data: { pct: Math.round((before - after) / before * 100) } }] };
      return { skipped: [{ messageId: 'resample.skipped.minimal', data: {} }] };
    },
  },

  {
    meta: {
      id: 'structure/prune-final', category: 'scene', title: 'Cleanup of orphaned resources', titleKey: 'rule.structurePruneFinal',
      severity: 'info', fixSafety: 'provable', tier: 'basic', runAfter: ['scene/join', 'geometry/orphan-vertices'], touches: ['accessor', 'node'],
      reversible: false, dataLoss: 'none', // только осиротевшие после предыдущих фиксов ресурсы
      enabled: (o) => o.safe || o.join || o.compress, // финальная зачистка после safe/склейки/компрессии

    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    // Та же причина, что у structure/prune-unused: чистка не видит ссылок из
    // неизвестного расширения и уносит живые данные вместе с осиротевшими.
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || refuseIfWouldEmptyScene(ctx) || { safe: true, messageId: 'pruneFinal.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const b = root.listAccessors().length;
      await ctx.document.transform(fns.prune()); // как в v2: подчистка после всех проходов
      const a = root.listAccessors().length;
      if (b > a) return { details: [{ messageId: 'pruneFinal.done', data: { n: b - a } }] };
      return {};
    },
  },

  {
    meta: {
      // Текстура, залитая ОДНИМ цветом, ужимается до одного пикселя.
      //
      // Мысль Александра (2026-08-17): «текстуры полностью залитые одним цветом должны
      // ужиматься максимально сразу. например полностью чёрный или полностью синяя
      // нормалмапа. её сделать на пару пикселей и сжать максимально».
      //
      // Правилу 11 это не противоречит: заливка одним цветом не несёт НИКАКОЙ
      // пространственной информации, и её разрешение — не замысел автора, а остаток
      // экспорта. Никто не рисует 2048×2048 ради одного серого. Сам ЦВЕТ сохраняется
      // побайтно, поэтому картинка после правила означает ровно то же, что до него:
      // синяя нормаль (128,128,255) как говорила «рельефа нет», так и говорит.
      //
      // ЦЕНА ЗДЕСЬ НЕ В ФАЙЛЕ, А В ВИДЕОПАМЯТИ, и это главное. Плоскую заливку любой
      // кодек жмёт почти в ноль — 2048×2048 весит на диске 33 КБ. Но видеокарта хранит
      // пиксели РАСПАКОВАННЫМИ, и ей всё равно, что они одинаковые: та же текстура
      // занимает 21.3 МБ видеопамяти. Разница в 660 раз. Замер на 61 реальной модели
      // (`_work/flat-vram.mjs`): пять таких текстур — 100 КБ файла и 64 МБ видеопамяти.
      id: 'textures/flat', category: 'textures', title: 'Single-colour textures', titleKey: 'rule.texturesFlat',
      severity: 'info', fixSafety: 'provable', tier: 'basic',
      // После dedup: побайтно одинаковые копии к этому моменту уже сведены в одну, и
      // мы не разбираем одну и ту же заливку по нескольку раз.
      runAfter: ['structure/dedup'], touches: ['texture'],
      // Цвет сохранён точно, размер картинки к её смыслу отношения не имел.
      reversible: false, dataLoss: 'none',
      enabled: (o) => o.safe,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'flat.safe', data: {} }; },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const sharp = (await import('sharp')).default; // ленивый импорт, как у KTX2 и WebP

      let n = 0;
      let failed = 0;
      let vramSaved = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const img = tex.getImage();
        if (!img || !img.byteLength) continue;
        // KTX2 обычным декодером не читается, а разворачивать его ради поиска заливки
        // дороже, чем возможная находка: в этом формате модели приходят уже собранными.
        if (tex.getMimeType() === 'image/ktx2') continue;

        const res = await attempt(async () => {
          // Сперва ДЕШЁВЫЙ отсев по заголовку, и он здесь не оптимизация, а условие
          // жизнеспособности правила: разбор пикселей (stats) распаковывает картинку
          // целиком, и на модели из 33 текстур это 2 секунды НА КАЖДОМ прогоне. Чтение
          // одних заголовков — 8 мс, в 250 раз дешевле (замер 2026-08-17).
          //
          // Признак заливки — ничтожный вес на пиксель: 2048×2048 одного цвета весит
          // 33 КБ, то есть 0.008 байта на пиксель, тогда как настоящая картинка занимает
          // десятые доли байта и больше. Порог 0.05 оставляет запас в шесть раз.
          // Мелкие картинки пропускаем к разбору без вопросов: у них служебные байты
          // формата перевешивают сами пиксели (4×4 заливка — 4.4 байта на пиксель),
          // и отсев по весу отбросил бы именно то, что ищем. Распаковать их даром.
          const meta = await sharp(Buffer.from(img)).metadata();
          const w = meta.width || 0;
          const h = meta.height || 0;
          if (w <= 1 && h <= 1) return null; // уже ужата
          const px = w * h;
          if (px > 4096 && img.byteLength / px > 0.05) return null; // на заливку не похоже

          const stats = await sharp(Buffer.from(img)).stats();
          // Заливка одним цветом: у КАЖДОГО канала минимум равен максимуму. Альфу
          // проверяем наравне с цветом — прозрачность тоже бывает рисунком.
          //
          // ГРАНИЦА, и она намеренная. Сравнение СТРОГОЕ, поэтому заливка, пришедшая в
          // ЛОССОВОМ WebP, здесь не находится: замер 2026-08-18 — сплошной RGB(50,60,70)
          // после WebP q90 читается как 50/52 · 59/60 · 70/70. PNG, WebP без потерь и
          // даже JPEG отдают заливку точно, лоссовый WebP — нет.
          //
          // Смягчить допуск нельзя молча: это уже выбор ПРЕДСТАВИТЕЛЬНОГО цвета вместо
          // настоящего, то есть правка пикселей автора, а по Правилу 11 сомнение решается
          // в пользу сохранности и разговором с Александром, а не догадкой.
          if (!stats.channels.every((c) => c.min === c.max)) return null;
          // PNG, а не формат исходника: он без потерь, и цвет доедет побайтно. Один
          // пиксель в PNG — меньше сотни байт, спорить тут не о чем.
          const one = await sharp(Buffer.from(img)).resize(1, 1, { kernel: 'nearest' }).png().toBuffer();
          return { one, w, h, channels: stats.channels.length };
        });
        // Два РАЗНЫХ исхода, и раньше они были склеены в одну строку.
        //   res.ok === false  — картинку не удалось разобрать (битые байты, формат не по
        //                       заголовку, отказ sharp). Это СБОЙ: галочка стояла, работа
        //                       не сделана, и человек обязан об этом узнать — Правило 12.
        //   res.value === null — разобрали и увидели, что заливкой это не является.
        //                       Законный исход, говорить нечего.
        // Склейка означала, что битая текстура молча выпадала из работы под видом
        // «не заливка». Найдено ревью 2026-08-18.
        if (!res.ok) { failed += 1; continue; }
        if (!res.value) continue;

        const { one, w, h, channels } = res.value;
        // Видеопамять считаем ДО подмены и тем же способом, что метрика в шапке:
        // распакованные пиксели плюс пирамида уровней (коэффициент 4/3).
        vramSaved += Math.round(w * h * channels * 4 / 3);
        tex.setImage(new Uint8Array(one)).setMimeType('image/png');
        n += 1;
      }

      // О сбоях сообщаем ДО выхода по «ничего не нашли»: иначе битые текстуры пропадали
      // вместе с ним. Одна строка на класс, без имён (Правило 9).
      if (failed) out.skipped.push({ messageId: 'flat.skipped.failed', data: { n: failed } });

      if (!n) return out;

      // Правило меняет ФОРМАТ картинки (в PNG), а формат объявлен расширением. Если
      // после нас в модели не осталось ни одной WebP-текстуры, `EXT_texture_webp` в
      // extensionsRequired — это ложь: загрузчик обязан отказать файлу, который требует
      // расширение, которым тот больше не пользуется, и модель из одних PNG переставала
      // открываться там, где WebP не поддержан. Ровно тот же снос, что делает
      // textures/webp для KHR_texture_basisu. Воспроизведено ревью 2026-08-18: BoomBox
      // с заливками в WebP без потерь, прогон `safe` — на выходе все image/png и
      // extensionsRequired ['EXT_texture_webp'].
      const mimesNow = ctx.document.getRoot().listTextures().map((t) => t.getMimeType());
      if (!mimesNow.some((m) => m === 'image/webp')) {
        for (const used of ctx.document.getRoot().listExtensionsUsed()) {
          if (used.extensionName === 'EXT_texture_webp') used.dispose();
        }
      }

      // Одна строка на класс случаев, а не на текстуру (Правило 9). Видеопамять названа
      // прямо: без неё выигрыш выглядит копеечным и человек справедливо не поймёт, зачем
      // мы вообще трогали его текстуры.
      out.found.push({ messageId: 'flat.found', data: { n } });
      out.details.push({ messageId: 'flat.done', data: { n, vramMb: Math.round(vramSaved / 1048576) } });
      return out;
    },
  },

  {
    meta: {
      // Уменьшение текстур до выбранного потолка (решение Александра 2026-08-12:
      // «нужно сделать изменение размера 4к, 2к, 1к, 512 на 512»).
      //
      // Молча не делается НИКОГДА: выбор из четырёх размеров — взаимоисключающая группа
      // `texture-size` в index.mts, ничего не выбрано — правило выключено. Это `lossy`:
      // выброшенные пиксели не возвращаются ни распаковкой, ни чем-либо ещё, поэтому
      // canFix отдаёт `force` — то есть «применяем, потому что человек выбрал это сам»,
      // а не потому, что потолок автофикса позволил.
      id: 'textures/resize', category: 'textures', title: 'Texture downscale', titleKey: 'rule.texturesResize',
      severity: 'warn', fixSafety: 'lossy', tier: 'advanced',
      // feature НЕ указан намеренно: у группы четыре члена, и один из них в этом поле
      // назвал бы человеку не ту галочку, которую он видел («флажок resize-2048 не
      // включён» тому, кто не выбирал ни одного). Вместо него — featureGroup: правило
      // объявляет свой выключатель, не называя конкретный размер. Цена — правило молчит,
      // когда размер не выбран; это верно и есть, выбирать по умолчанию нечего.
      featureGroup: 'texture-size',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: false, dataLoss: 'significant',
      enabled: (o) => o.maxTextureSize > 0,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, force: true, messageId: 'resize.safe', data: {} }; },
    async fix(finding, ctx) {
      const out: FixOut = { found: [], skipped: [], details: [] };
      const target = ctx.opts.maxTextureSize;

      // Что вообще можно уменьшить. KTX2/Basis/DDS — это данные, уже разложенные под
      // видеокарту блоками; уменьшить их значит распаковать, отресайзить и сжать заново,
      // то есть заплатить потерей качества ДВАЖДЫ за то, что человек просил один раз.
      // Честнее отказаться и сказать: сожмите после уменьшения, а не до.
      const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

      const big: { tex: Texture; mime: string; w: number; h: number }[] = [];
      let compressed = 0;
      let unreadable = 0;

      for (const tex of ctx.document.getRoot().listTextures()) {
        const image = tex.getImage();
        const mime = tex.getMimeType();
        if (!image || !mime) continue;
        if (!RESIZABLE.has(mime)) { compressed++; continue; }
        const size = textureSize(image, mime);
        if (!size) { unreadable++; continue; }
        if (Math.max(size[0]!, size[1]!) <= target) continue; // меньше цели — не трогаем
        big.push({ tex, mime, w: size[0]!, h: size[1]! });
      }

      // Отказы называем всегда, даже когда уменьшать было нечего: человек выбрал размер
      // и вправе знать, почему часть картинок осталась прежней.
      if (compressed) out.skipped.push({ messageId: 'resize.skipped.compressed', data: { n: compressed } });
      if (unreadable) out.skipped.push({ messageId: 'resize.skipped.unreadable', data: { n: unreadable } });
      if (!big.length) return out;

      const sharp = (await import('sharp')).default; // ленивый импорт: тот же путь, что у WebP
      let done = 0;
      let failed = 0;
      let bytesBefore = 0;
      let bytesAfter = 0;

      for (const c of big) {
        const before = c.tex.getImage()!;
        const res = await attempt(async () => {
          const [w, h] = fitInside(c.w, c.h, target);
          // fit:'fill' — размеры считаем сами (fitInside), а не отдаём на откуп sharp.
          // Причина в замере 2026-08-12 на вопрос Александра про нестандартные размеры:
          // 1500×1200 при цели 1024 даёт 1024×819, и toktx МОЛЧА превращает 819 в 820 —
          // ему нужны блоки 4×4. Отказа нет, но одна и та же выбранная цель давала два
          // разных файла: 819 без KTX2 и 820 с ним. Теперь меньшую сторону округляем мы,
          // до кратного четырём, и результат один при любом наборе флажков.
          const pipeline = sharp(Buffer.from(before)).resize({ width: w, height: h, fit: 'fill' });
          // Формат сохраняем входной: смена формата — работа соседних правил (KTX2/WebP),
          // и делать её здесь значило бы менять две вещи под одной галочкой.
          const encoded = c.mime === 'image/png' ? await pipeline.png().toBuffer()
            : c.mime === 'image/jpeg' ? await pipeline.jpeg({ quality: 90 }).toBuffer()
              : await pipeline.webp({ quality: 90 }).toBuffer();
          c.tex.setImage(new Uint8Array(encoded));
          return encoded;
        });
        // Битая картинка не должна ронять сборку — тот же принцип, что у WebP.
        if (!res.ok) { failed++; continue; }
        bytesBefore += before.byteLength;
        bytesAfter += res.value.byteLength;
        done++;
      }

      // Одна строка на класс (Правило 9): текстур бывают десятки, и «уменьшена
      // baseColor_3» двадцать раз — это дефект отчёта, а не подробность.
      if (done) {
        out.found.push({ messageId: 'resize.found', data: { n: done, px: target } });
        out.irreversibleSafety = 'lossy';
        (out.irreversible ??= []).push({
          messageId: 'resize.done',
          data: { n: done, px: target, kb: Math.max(0, Math.round((bytesBefore - bytesAfter) / 1024)) },
        });
      }
      if (failed) out.skipped.push({ messageId: 'resize.skipped.failed', data: { n: failed } });
      return out;
    },
  },

  {
    meta: {
      // ADVANCED: KTX2 требует KTX2Loader (Three.js) / поддержку basisu в движке —
      // работает не «везде», поэтому только явный opt-in (advancedFeatures:['ktx2'] / --ktx2).
      // normalizeOpts переводит выбор фичи в noKtx:false — enabled смотрит на итоговую опцию.
      id: 'textures/ktx2', category: 'textures', title: 'Textures → KTX2/UASTC', titleKey: 'rule.texturesKtx2',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      // После textures/resize: кодировать надо уже уменьшенное. Иначе платим кодеком за
      // пиксели, которые сами же и выбросим, а на 4K это минуты работы toktx.
      runAfter: ['structure/prune-final', 'textures/resize'], touches: ['texture'],
      reversible: true, dataLoss: 'minor', // §4d: KTX2 ↔ PNG/WebP, потеря от BASIS-U распаковки
      reversalNoteKey: 'reversal.ktx2',
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !HAS_GLTF_CLI) {
        return { safe: false, messageId: 'ktx2.noTools', data: {} };
      }
      return { safe: true, messageId: 'ktx2.safe', data: {} };
    },
    async fix(finding, ctx) {
      // Аннотация нужна: пустой массив без неё выводится как never[], и push в него —
      // ошибка. Необязательные каналы (irreversible, cost) объявлены здесь же, потому
      // что правило наполняет их условно, уже после создания объекта.
      const out: FixOut = { found: [], skipped: [], details: [] };
      // Вес картинок до перекодирования — чтобы в конце сказать, во что обошёлся KTX2.
      // Мерить надо здесь, внутри правила: снаружи видно только итоговый файл, а в нём
      // смешаны все включённые оптимизации, и приписать рост конкретной галочке уже
      // нельзя — останется гадание.
      const imageBytes = () => {
        let n = 0;
        for (const tex of ctx.document.getRoot().listTextures()) {
          const img = tex.getImage();
          if (img) n += img.byteLength;
        }
        return n;
      };
      const imgBefore = imageBytes();
      const dataTex = [];
      const colorTex = [];
      // Перекодированные в PNG копим и отчитываемся ОДНОЙ строкой в конце: строка
      // на каждую текстуру давала тринадцать одинаковых записей подряд.
      const toPng = new Map(); // исходный mime → сколько штук
      // Уже-KTX2 копим группой по той же причине (одна запись на класс случаев,
      // docs/EXTENDING.md §5b): на модели, которую прогнали вторым заходом, строка
      // на текстуру давала столько же одинаковых записей, сколько текстур.
      const alreadyKtx2 = [];
      let pngFailed = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '';
        if (mime === 'image/ktx2') {
          alreadyKtx2.push(name || '—');
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
          const conv = await attempt(async () => {
            const png = await sharp(Buffer.from(tex.getImage()!)).png().toBuffer();
            tex.setImage(png);
            tex.setMimeType('image/png');
          });
          if (!conv.ok) { pngFailed++; continue; }
          toPng.set(mime, (toPng.get(mime) || 0) + 1);
        }
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      // Одна текстура — называем её по имени; несколько — только счёт (как у WebP).
      if (alreadyKtx2.length === 1) out.skipped.push({ messageId: 'ktx2.skipped.already', data: { name: alreadyKtx2[0] } });
      else if (alreadyKtx2.length > 1) out.skipped.push({ messageId: 'ktx2.skipped.already.many', data: { n: alreadyKtx2.length } });
      for (const [mime, n] of toPng) {
        out.details.push({ messageId: 'ktx2.done.toPng', data: { n, from: mime.replace('image/', '') } });
      }
      if (pngFailed) out.skipped.push({ messageId: 'ktx2.skipped.toPngFailed', data: { n: pngFailed } });
      const needKtx = dataTex.length + colorTex.length;
      if (needKtx === 0) {
        ctx.log(render('ktx2.log.skipped', {}, ctx.opts.locale));
        return out;
      }
      out.found.push({ messageId: 'ktx2.found', data: { n: needKtx } });
      const mixed = ctx.opts.texMode === 'mixed';
      ctx.log(render('ktx2.log.encoding', { n: needKtx, mixed }, ctx.opts.locale));
      // Промежуточные файлы KTX2-конвейера. Раньше лежали в ctx.outDir под именами
      // `_tmp_<имя модели>` — два параллельных вызова с одинаковым именем модели писали
      // в один и тот же файл, и модель получала чужие текстуры. Отдельный каталог в
      // системной temp снимает и это, и второй случай: модель, которую УЖЕ зовут
      // `_tmp_model.glb`, совпадала по имени с temp-файлом соседней `model.glb`.
      // Побочно: аварийно завершённый процесс больше не оставляет мусор в output/ —
      // недобранное подчистит ОС.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-ktx2-'));
      const tmpA = path.join(tmpDir, `_tmp_${ctx.dstName}`);
      const tmpB = path.join(tmpDir, `_tmp2_${ctx.dstName}`);
      const tmpC = path.join(tmpDir, `_tmp3_${ctx.dstName}`);
      try {
        await ctx.io.write(tmpA, ctx.document);
        let cur = tmpA;
        // await обязателен: runCli стал асинхронным (ревью 2026-08-10, P1.1 — раньше
        // он держал event loop минутами). Без await следующий шаг читал бы файл,
        // которого ещё нет.
        if (mixed) {
          if (dataTex.length) { await runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { await runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          await runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
          cur = tmpB;
        }
        ctx.document = await ctx.io.read(cur); // дальше пайплайн работает с KTX2-версией
        relabelDataTextures(ctx.document, fns, out);
      } finally {
        // каталог целиком — вместе с тем, что мог дописать сам toktx
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* занят — подчистит ОС */ }
      }
      if (mixed) {
        // Имена перечисляем, только если они есть: у безымянных текстур список
        // выродился бы в «—, —, —, —, —».
        const named = (list: string[]) => list.filter(Boolean).join(', ');
        if (colorTex.length) out.details.push({ messageId: 'ktx2.done.color', data: { n: colorTex.length, list: named(colorTex) } });
        if (dataTex.length) out.details.push({ messageId: 'ktx2.done.data', data: { n: dataTex.length, list: named(dataTex) } });
      } else {
        out.details.push({ messageId: 'ktx2.done.uastc', data: { n: needKtx } });
      }

      // Цена KTX2. На большой текстуре он выигрывает и в файле, и в видеопамяти; на
      // мелкой служебные данные контейнера весят больше самой картинки, и по файлу
      // выходит проигрыш при честном выигрыше по памяти. Замер на
      // `Draco Compressed Input 01`: 6 380 → 74 264 байта (+1064 %) при видеопамяти
      // 5.3 → 1.3 МБ (−75 %). Порог вдвое, а не «любой рост», и здесь это ОСТАВЛЕНО
      // сознательно, в отличие от WebP ниже, где порог снят 2026-08-18. Разница по сути:
      // у WebP файл — единственный ресурс, и рост по нему это чистый проигрыш. KTX2 же
      // МЕНЯЕТ файл на видеопамять по замыслу, и небольшой рост файла — названная цена
      // выигранных мегабайт, а не дефект. Снимать порог и здесь можно, но сначала нужен
      // такой же замер по корпусу, какой сделан для WebP: сколько моделей попадёт в знак
      // и не превратится ли он в постоянный фон. Замера нет — порог не трогаем.
      const imgAfter = imageBytes();
      if (imgBefore > 0 && imgAfter > imgBefore * 2) {
        out.cost = [{
          messageId: 'ktx2.grewFile',
          data: {
            beforeKb: Math.round(imgBefore / 1024),
            afterKb: Math.round(imgAfter / 1024),
            pct: Math.round((imgAfter - imgBefore) / imgBefore * 100),
          },
        }];
      }
      return out;
    },
  },

  {
    meta: {
      // WebP — второй ответ на текстуры, противоположный KTX2 по смыслу, и потому
      // взаимоисключающий с ним (в интерфейсе — один выбор на двоих).
      //
      //   KTX2 остаётся сжатым НА ВИДЕОКАРТЕ: видеопамять падает в 4–8 раз, а файл
      //   нередко растёт — на мелкой текстуре служебные данные контейнера весят больше
      //   самой картинки (замерено: +1064 % на `Draco Compressed Input 01`).
      //
      //   WebP распаковывается в ту же несжатую RGBA: видеопамять НЕ меняется вовсе,
      //   зато файл меньше JPEG/PNG. Это ответ на «страницу должно быстро открыть»,
      //   а не на «модель не должна съесть память телефона».
      //
      // Расширение EXT_texture_webp ратифицировано Khronos, three.js понимает его
      // из коробки, без отдельного декодера, — поэтому значка ⚠ у опции нет.
      //
      // ГАЛОЧКА СТОИТ — ТЕКСТУРЫ СТАНОВЯТСЯ WebP. Все, без исключений (Правило 12,
      // Александр 2026-08-17). Раньше правило обходило стороной KTX2 («это уже формат
      // для видеокарты»), уже-WebP, картинки без объявленного mime и карты данных в
      // JPEG — и человек, выбравший WebP, получал в метаданных KHR_texture_basisu без
      // единого слова объяснения. Теперь отказ бывает ровно один: кодировщик не смог,
      // и тогда виновная текстура названа по имени с причиной.
      id: 'textures/webp', category: 'textures', title: 'Textures → WebP', titleKey: 'rule.texturesWebp',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'webp',
      // После textures/resize по той же причине, что и KTX2: сжимаем уже уменьшенное.
      runAfter: ['structure/prune-final', 'textures/resize'], touches: ['texture'],
      reversible: true, dataLoss: 'minor',
      reversalNoteKey: 'reversal.webp',
      enabled: (opts) => !opts.noWebp,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'webp.safe', data: {} }; },
    async fix(finding, ctx) {
      // Аннотация нужна: пустой массив без неё выводится как never[], и push в него —
      // ошибка. Необязательные каналы (irreversible, cost) объявлены здесь же, потому
      // что правило наполняет их условно, уже после создания объекта.
      const out: FixOut = { found: [], skipped: [], details: [] };

      // Галочка называет ЦЕЛЕВОЕ СОСТОЯНИЕ («пусть текстуры будут WebP»), а не действие
      // («пережать»). Отсюда весь разбор (Александр, 2026-08-17):
      //
      //   PNG, JPEG, пустой mime — цели не достигли → кодируем;
      //   KTX2                   — цели не достиг  → распаковываем и кодируем;
      //   уже WebP               — ЦЕЛЬ ДОСТИГНУТА → работы нет.
      //
      // Последнее — не тот молчаливый отказ, что запрещает Правило 12. Разница ровно
      // одна: после прежних отказов модель НЕ была в обещанном состоянии (KTX2 оставался
      // KTX2), а здесь она в нём уже находится. Пережимать её незачем и вредно: WebP —
      // один формат, но с ручкой качества, и второй проход с НАШИМ качеством и файл
      // растит, и картинку портит. Замер на этой самой модели: автор сжал на ~q75–q80,
      // наш q90 давал +32 % веса при худшем изображении. Даже прицел ровно в её потолок
      // (оценка q81) даёт +6 %: пережатие WebP в WebP не бывает бесплатным в принципе.
      //
      // Ползунок качества (Александр, 2026-08-17). Шкала — доля от качества ИСХОДНИКА:
      // «если они уже сжаты, мы ведь не можем вернуть качество — значит это для нас уже
      // и есть всегда 100 процентное качество». Выше 100 шкала не идёт намеренно.
      //
      // Ползунок сдвигает ровно одну границу разбора выше — последнюю. Пока он на сотне,
      // цель «быть WebP», и уже-WebP ей отвечает. Сдвинули — человек попросил ЛЕГЧЕ, и та
      // же текстура цели больше не отвечает: работаем. Его слова, когда увидел обратное:
      // «WebP-модель не меняется вовсе — не должно быть такого. мы не можем сами дальше
      // сжать никак вообще?» Можем. Безопасно это ровно потому, что умолчание — сотня:
      // без просьбы человека ни одна уже-WebP текстура не трогается.
      const share = webpShare(ctx.opts.webpQuality);
      const atCeiling = share >= 100;

      const cands: WebpCandidate[] = [];
      let alreadyTarget = 0;
      for (const tex of ctx.document.getRoot().listTextures()) {
        const image = tex.getImage();
        if (!image || !image.byteLength) continue; // кодировать нечего — картинки нет вовсе
        if (atCeiling && tex.getMimeType() === 'image/webp') { alreadyTarget += 1; continue; }
        cands.push({
          tex,
          name: tex.getName() || '—',
          mime: tex.getMimeType() || '',
          // Тот же раздел, что у KTX2: нормали, occlusion и roughness — это ЧИСЛА,
          // а не картинка. Лоссовый WebP режет цветность (4:2:0) и портит вектор
          // нормали, поэтому им — только lossless, цветным — обычное сжатие.
          // Это выбор СПОСОБА кодирования, а не отказ кодировать: Правило 12 запрещает
          // второе и никак не ограничивает первое.
          isData: DATA_SLOT_RE.test(fns.listTextureSlots(tex).join(' ')),
        });
      }
      // Строка про уже достигнутую цель идёт в «Что сделано», а НЕ в отказы: это
      // состояние модели, а не наше воздержание. И она обязана быть — молчание здесь
      // было бы неотличимо от прежнего тихого пропуска.
      const reportAlreadyTarget = () => {
        if (alreadyTarget) out.details.push({ messageId: 'webp.alreadyTarget', data: { n: alreadyTarget } });
      };
      if (!cands.length) { reportAlreadyTarget(); return out; }

      const sharp = (await import('sharp')).default; // ленивый импорт: тот же путь, что у KTX2

      // Две разные тяжести, и обе надо мерить отдельно. Вес КАРТИНОК — это размер
      // скачиваемого файла. ВИДЕОПАМЯТЬ — это то, что модель займёт на видеокарте, и
      // меняется она в другую сторону: KTX2 остаётся сжатым на GPU, WebP разворачивается
      // в полную RGBA. На DiffuseTransmissionTeacup файл падает 5.76 → 1.94 МБ, а
      // видеопамять растёт 12 → 48 МБ. Показать только первое значило бы соврать.
      const imageBytes = () => ctx.document.getRoot().listTextures()
        .reduce((sum, t) => sum + (t.getImage()?.byteLength || 0), 0);
      // Через шов attempt, а не своим try/catch: inspect срывается на экзотике, но
      // обходить единственный шов файла ради этого нельзя — сторож
      // tests/architecture/rule-resilience.test.mjs считает catch-блоки во всём rules.mts
      // именно затем, чтобы такие «мелкие» исключения не расползались по правилам.
      const gpuBytes = async (): Promise<number> => {
        const res = await attempt(() => {
          // Тот же источник, что и у метрики gpuBytes в metrics.mts, — иначе цена у
          // галочки и цифра в шапке считались бы по-разному и однажды разошлись бы.
          let total = 0;
          for (const t of fns.inspect(ctx.document).textures.properties) total += t.gpuSize || 0;
          return total;
        });
        return res.ok ? res.value : 0; // не сосчиталось — цену по памяти просто не назовём
      };
      const bytesBefore = imageBytes();
      const vramBefore = await gpuBytes();

      // Кодируем по одной. Результат оставляем ВСЕГДА — даже если он тяжелее исходного.
      // Прежде здесь стоял молчаливый откат «потяжелело — вернули как было», и он
      // ровно та самая неработающая клавиша: человек включает WebP в том числе чтобы
      // ИЗМЕРИТЬ цену, а откат превращал его замер во враньё. Потяжелевший результат
      // теперь виден в отчёте красным знаком у этой же галочки (канал cost ниже).
      await Promise.all(cands.map(async (c) => {
        const src = c.tex.getImage()!;
        const res = await attempt(async () => {
          let pipeline;
          if (c.mime === 'image/ktx2') {
            // Формат для видеокарты сам себя не отдаёт: сперва разворачиваем его
            // в обычные пиксели транскодером Basis, и только потом кодируем.
            const { image, reason } = await decodeKtx2(src);
            if (!image) throw new Error(reason || 'ktx2.decodeFailed');
            c.fromGpu = true;
            pipeline = sharp(Buffer.from(image.data), {
              raw: { width: image.width, height: image.height, channels: 4 },
            });
          } else {
            pipeline = sharp(Buffer.from(src));
          }
          // Потолок исходника — то, выше чего прыгнуть нельзя. Читается по байтам, а не
          // по mime: mime у моделей врёт или отсутствует, это мы уже видели.
          const ceiling = readCeiling(src, c.mime);
          if (ceiling.how === 'probe') {
            // У WebP качество в файле не записано вовсе — только оценка пробными
            // кодированиями (PROBE_STEPS штук на текстуру, замер: 11 текстур → 32 с).
            // Ветка достижима лишь когда ползунок сдвинут: на 100 такая текстура уже
            // отсеяна как достигшая цели, и платить за оценку не приходится.
            ceiling.q = await probeWebpCeiling(
              src.byteLength,
              (q) => sharp(Buffer.from(src)).webp({ quality: q }).toBuffer(),
            );
          }
          if (ceiling.how === 'unknown') ceiling.q = WEBP_UNKNOWN_CEILING;
          c.how = ceiling.how;
          // Присваиваем только когда потолок есть: при exactOptionalPropertyTypes запись
          // undefined в необязательное поле — не то же самое, что его отсутствие.
          if (ceiling.q !== null) c.sourceQ = ceiling.q;

          // Без потерь — только когда исходник САМ без потерь и человек не просил хуже.
          // Иначе это чистый проигрыш: информацию уничтожил первый кодек, а lossless лишь
          // дорого копирует его артефакты (замер: карта данных 4184 → 28233 КБ).
          // smartSubsample отключает прореживание цветности — нормалям и roughness это
          // важнее лишних процентов размера.
          c.lossless = ceiling.how === 'lossless' && atCeiling;
          const q = targetQuality(ceiling, share);
          const encoded = await (c.lossless
            ? pipeline.webp({ lossless: true })
            : pipeline.webp(c.isData ? { quality: q, smartSubsample: true } : { quality: q })
          ).toBuffer();
          c.tex.setImage(new Uint8Array(encoded)).setMimeType('image/webp');
        });
        // Битая или экзотическая картинка не должна ронять всю сборку.
        if (!res.ok) c.failed = res.reason;
      }));

      // Расширение объявляем сами: transform этого больше не делает, а какая-то из
      // текстур могла не закодироваться и остаться в прежнем формате.
      const ext = ctx.document.createExtension(EXTTextureWebP);
      const mimesNow = ctx.document.getRoot().listTextures().map((t) => t.getMimeType());
      if (mimesNow.some((m) => m === 'image/webp')) ext.setRequired(true);
      else ext.dispose();

      // KHR_texture_basisu, оставшееся без единой своей текстуры, — это ложь в
      // extensionsRequired: загрузчик обязан отказать файлу, требующему расширение,
      // которым тот больше не пользуется. Снимаем ровно тогда, когда ktx2 не осталось.
      if (!mimesNow.some((m) => m === 'image/ktx2')) {
        for (const used of ctx.document.getRoot().listExtensionsUsed()) {
          if (used.extensionName === 'KHR_texture_basisu') used.dispose();
        }
      }

      // Карты данных распадаются на ТРИ случая, и разводит их ИСТОЧНИК, а не то, как мы
      // в итоге закодировали. Пока lossless зависел только от источника, второе совпадало
      // с первым; с появлением ползунка совпадение кончилось, и карта из честного PNG,
      // сжатая по просьбе человека, получала объяснение «пришла уже сжатой» — неправда
      // про его собственную модель (поймано замером на BoomBox, 2026-08-17).
      const ok = cands.filter((c) => !c.failed);
      const color = ok.filter((c) => !c.isData);
      const data = ok.filter((c) => c.isData && c.lossless);
      // Источник был лоссовым — сохранять нечего, и это НЕ выбор человека, а факт файла.
      const dataLossy = ok.filter((c) => c.isData && !c.lossless && c.how !== 'lossless');
      // Источник был без потерь, огрубили по прямой просьбе. Молчать нельзя: числа
      // нормалей испорчены, и причина этому — сдвинутый ползунок, а не чужой экспорт.
      const dataByChoice = ok.filter((c) => c.isData && !c.lossless && c.how === 'lossless');
      const fromGpu = ok.filter((c) => c.fromGpu);
      const failed = cands.filter((c) => c.failed);

      reportAlreadyTarget();
      out.found.push({ messageId: 'webp.found', data: { n: cands.length } });

      // Качество исходника — ОДНА строка на модель, а не на текстуру (Правило 9). Именно
      // она отвечает на вопрос «а насколько модель уже пережата»: у ABeautifulGame это
      // 77…97, и одно число было бы полуправдой, поэтому при разбросе показываем размах.
      const known = ok.filter((c) => c.sourceQ !== undefined && c.how !== 'unknown');
      if (known.length) {
        const qs = known.map((c) => c.sourceQ!);
        const min = Math.min(...qs);
        const max = Math.max(...qs);
        // «Примерно» стоит ВСЕГДА, и у JPEG тоже. Сперва здесь был флаг exact: у JPEG
        // качество читается из файла, и это казалось измерением. Ревью 2026-08-18
        // измерило: кодировщик собран с mozjpeg, чьи таблицы квантования отличаются от
        // эталонных IJG, и обратный ход даёт ошибку до шести единиц в середине шкалы
        // (исходное 50 читается как 44, 75 как 71, 95 как 95). Каким кодировщиком сделан
        // ЧУЖОЙ файл, мы не знаем никогда — значит и точности обещать не можем.
        //
        // Две ветки с явными ключами, а не один тернарник в поле messageId: сторож
        // ключей-сирот (tests/engine-contract) разбирает исходник статически, и внутри
        // тернарника ключ ему не виден — строка каталога числилась бы мёртвой.
        const qData = { n: known.length, q: min, min, max };
        if (min === max) out.details.push({ messageId: 'webp.sourceQuality', data: qData });
        else out.details.push({ messageId: 'webp.sourceQuality.range', data: qData });
      }
      // Потолок неизвестен — сказать обязательно: там мы подставили своё число, а не
      // прочитали авторское, и человек имеет право знать, что эта часть модели не
      // подчиняется ползунку так же точно, как остальная.
      const unknownCeiling = ok.filter((c) => c.how === 'unknown');
      if (unknownCeiling.length) {
        out.details.push({ messageId: 'webp.ceilingUnknown', data: { n: unknownCeiling.length, q: WEBP_UNKNOWN_CEILING } });
      }
      // Сдвинутый ползунок называем прямо: это выбор человека, и в отчёте он должен быть
      // виден рядом с его последствиями, а не только в настройках.
      if (!atCeiling) out.details.push({ messageId: 'webp.quality', data: { share } });
      if (color.length) out.details.push({ messageId: 'webp.done.color', data: { n: color.length } });
      if (data.length) out.details.push({ messageId: 'webp.done.data', data: { n: data.length } });
      if (dataLossy.length) out.details.push({ messageId: 'webp.done.dataLossy', data: { n: dataLossy.length } });
      if (dataByChoice.length) out.details.push({ messageId: 'webp.done.dataByChoice', data: { n: dataByChoice.length, share } });
      // Распаковка из формата видеокарты стоит дорого и молчать об этом нельзя:
      // Basis сжимает с потерями, поэтому потери сложились дважды; пирамида уровней
      // потеряна; видеопамять вырастет. Отдельная строка, а не примечание к общей.
      if (fromGpu.length) out.details.push({ messageId: 'webp.done.fromGpu', data: { n: fromGpu.length } });
      // Сбой кодирования — редкий и единичный случай, его называем поимённо:
      // причина у каждой текстуры своя и она нужна для разбора.
      // Причина — ПОДСТАНОВКА-СООБЩЕНИЕ, когда она наша, и сырой текст, когда чужая.
      //
      // Правило 8: пользовательскую строку нельзя собирать из того, что придумал код.
      // Транскодер KTX2 возвращает свои токены (`ktx2.hdr`, `ktx2.invalid` и прочие), и
      // они попадали в отчёт ДОСЛОВНО, в обоих языках (найдено ревью 2026-08-18). Теперь
      // известный токен уходит как { messageId, data } — core/i18n.mjs развернёт его по
      // каталогу. Текст исключения из sharp остаётся как есть: перевести произвольную
      // ошибку чужой библиотеки нечем, и подменять её выдуманной фразой было бы хуже.
      for (const c of failed) {
        const known = c.failed && KTX2_REASONS.has(c.failed);
        out.skipped.push({
          messageId: 'webp.skipped.failed',
          data: { name: c.name, reason: known ? { messageId: c.failed!, data: {} } : c.failed },
        });
      }

      // Цена. Порог ВДВОЕ — и он здесь после того, как я его снял и вернул обратно.
      //
      // 2026-08-18, снял. Основанием был мой замер: будто ABeautifulGame при ползунке 100
      // растёт на 21 %, а человеку не говорят ни слова. ЗАМЕР БЫЛ НЕВЕРЕН ПО МЕТОДУ: он
      // делался прямым вызовом кодировщика на quality:100, а правило берёт качество
      // ИСХОДНИКА (у этой модели JPEG ≈83). Через само правило модель ужимается на 56 %.
      //
      // 2026-08-18, вернул — и вот что показал прогон уже БЕЗ порога. На `Dirty Cube 01`
      // (модель из репозитория, её видит CI) появилась запись webp.grewVram со своими же
      // числами: «было 16 МБ, стало 16 МБ, 0 %». То есть красный знак цены у галочки и
      // строка, которая сама показывает, что ничего не выросло. Рост там меньше мегабайта
      // и в печатаемые числа не попадает вовсе.
      //
      // Это ровно то, от чего порог и защищал, и прежний комментарий («небольшой рост —
      // обычная плата, кричать о нём значит приучить не читать») был прав. Я снял порог,
      // не проверив последствия на корпусе, и получил запись, врущую обоими способами
      // сразу: она утверждает рост и тут же его опровергает.
      //
      // Правило 9 про это прямо: отчёт не вываливает записи, которые человек читает как
      // итог и которые ничего не сообщают. Правило 12 требует честного ЗАМЕРА, а не
      // громкого — «выросло на 0 %» честнее не делает.
      //
      // Если однажды порог снимать снова, условием должно быть не «рост больше нуля», а
      // «рост ВИДЕН В ТЕХ ЧИСЛАХ, которые мы печатаем»: иначе сообщение опровергает само
      // себя. И проверять надо прогоном по корпусу, а не одной моделью.
      //
      // Красный знак встаёт у ЭТОЙ галочки — движок берёт адрес из meta.feature. Обе цены
      // могут гореть разом, и это не дублирование: файл и видеопамять — разные ресурсы,
      // и WebP на KTX2-модели выигрывает первый ровно за счёт второго.
      const cost: { messageId: string; data: Record<string, unknown> }[] = [];
      const bytesAfter = imageBytes();
      if (bytesBefore > 0 && bytesAfter > bytesBefore * 2) {
        cost.push({
          messageId: 'webp.grewFile',
          data: {
            beforeKb: Math.round(bytesBefore / 1024),
            afterKb: Math.round(bytesAfter / 1024),
            pct: Math.round((bytesAfter - bytesBefore) / bytesBefore * 100),
          },
        });
      }
      const vramAfter = await gpuBytes();
      if (vramBefore > 0 && vramAfter > vramBefore * 2) {
        cost.push({
          messageId: 'webp.grewVram',
          data: {
            beforeMb: Math.round(vramBefore / 1048576),
            afterMb: Math.round(vramAfter / 1048576),
            pct: Math.round((vramAfter - vramBefore) / vramBefore * 100),
          },
        });
      }
      if (cost.length) out.cost = cost;
      return out;
    },
  },

  {
    meta: {
      // tier advanced — обязательно. Сжатие геометрии должно идти ПОСЛЕ снимка
      // baseline-checkpoint, иначе снимок берётся с уже сжатой модели и сверка фазы 4
      // сравнивает Draco сам с собой: повреждение кодеком становится ненаблюдаемым.
      // Раньше стояло tier:'basic' с рассуждением «Meshopt базовый, advanced — только
      // выбор кодека». Практический эффект: правило попадало во второй проход лишь
      // косвенно, через runAfter ['textures/ktx2'] — и только когда KTX2 включён.
      // Без KTX2 (обычный случай `['safe','draco']`) сжатие уезжало в первый проход,
      // и checkpoint фиксировался уже после него.
      id: 'geometry/compress', category: 'geometry', title: 'Geometry compression', titleKey: 'rule.geometryCompress',
      severity: 'info', fixSafety: 'numeric', tier: 'advanced', runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'none', // §4d: Draco/Meshopt ↔ стандартный формат в пределах точности float32
      reversalNoteKey: 'reversal.compress',
      feature: 'meshopt', // компрессия геометрии — opt-in (флажок meshopt или draco → codec)
      enabled: (o) => o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'compress.safe', data: {} }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        // Область квантования и общий скин — см. quantizeOptions (TESTBUG-007).
        await ctx.document.transform(fns.meshopt({
          encoder: MeshoptEncoder,
          ...quantizeOptions(ctx.document),
        }));
      }
      return { details: [{ messageId: 'compress.done', data: { codec: ctx.opts.codec } }] };
    },
  },

  {
    meta: {
      // Квантование — третий способ уменьшить геометрию и единственный, которому НЕ нужен
      // декодер: числа координат переписываются 16- и 8-битными вместо 32-битных, а
      // three.js читает такую геометрию сам. Поэтому значка «нужен декодер» у опции нет.
      //
      // Но расширение попадает в extensionsRequired: движок, который его не знает,
      // откажется открыть файл целиком. Это не декодер, а требование к движку, и в
      // описании опции оно сказано словами.
      //
      // Взаимоисключение с Draco и Meshopt делает интерфейс (одна группа «Геометрия»),
      // но правило проверяет и само: у Draco своё встроенное квантование, Meshopt тянет
      // это же расширение внутри себя, и поверх них квантовать нечего — замерено на
      // `Production Draco Webp 01` (уже с Draco): геометрия −50 %, а ФАЙЛ +3 %.
      //
      // tier advanced по той же причине, что у geometry/compress: правило обязано идти
      // после baseline-checkpoint, иначе снимок берётся с уже квантованной модели и
      // сверка фазы 4 сравнивает результат сам с собой.
      id: 'geometry/quantize', category: 'geometry', title: 'Geometry quantization', titleKey: 'rule.geometryQuantize',
      severity: 'info', fixSafety: 'numeric', tier: 'advanced',
      runAfter: ['textures/ktx2', 'structure/prune-final'], touches: ['geometry', 'accessor'],
      reversible: true, dataLoss: 'minor', // §4d: разворачивается обратно в float32, но выброшенные разряды не возвращаются
      reversalNoteKey: 'reversal.quantize',
      feature: 'quantize',
      enabled: (o) => o.quantize,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'quantize.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();

      // Поверх Draco/Meshopt квантовать нечего: оба уже упаковали числа по-своему.
      //
      // Эта проверка идёт ПЕРВОЙ, и порядок здесь — не вкус (TESTBUG-008). Meshopt
      // сам кладёт в документ KHR_mesh_quantization, поэтому при обратном порядке
      // человек получал «геометрия уже квантована» вместо настоящей причины — он
      // сам только что выбрал Meshopt. Причина, которую человек может изменить,
      // важнее той, которая просто описывает состояние файла.
      if (ctx.opts.compress) {
        return { skipped: [{ messageId: 'quantize.skipped.compressed', data: { codec: ctx.opts.codec } }] };
      }
      // Уже квантована — второй проход только добавит потерь, ничего не выиграв.
      if (root.listExtensionsUsed().some((e) => e.extensionName === 'KHR_mesh_quantization')) {
        return { skipped: [{ messageId: 'quantize.skipped.already', data: {} }] };
      }

      const geomBytes = () => {
        let n = 0;
        for (const a of root.listAccessors()) n += a.getArray()?.byteLength || 0;
        return n;
      };
      const before = geomBytes();

      // Область квантования и общий скин — см. quantizeOptions (TESTBUG-007).
      const hasSkins = root.listSkins().length > 0;
      await ctx.document.transform(fns.quantize(quantizeOptions(ctx.document)));

      const after = geomBytes();
      const details: Message[] = [{
        messageId: 'quantize.done',
        data: { pct: before > 0 ? Math.round((before - after) / before * 100) : 0 },
      }];
      if (hasSkins) details.push({ messageId: 'quantize.done.scene', data: {} });
      return { details };
    },
  },
];
