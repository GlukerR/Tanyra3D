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
import { collectMetrics, countTriangles, effectiveSkins, listSemantics } from './metrics.mjs';
import { GLTF_CLI, TOKTX, runCli } from './tools.mjs';

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

function isColorTexture(tex, listSlots) {
  const declared = tex.getGraph().listParentEdges(tex).some((e) => e.getAttributes().isColor);
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

function relabelDataTextures(document, functions, out) {
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

function readAssetJson(srcPath) {
  const buf = fs.readFileSync(srcPath);
  // .gltf — обычный JSON; .glb — контейнер, первый чанк JSON (спецификация glTF 2.0 §4.4).
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x46546c67) {
    let off = 12;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32LE(off);
      const type = buf.readUInt32LE(off + 4);
      if (type === 0x4e4f534a) return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
      off += 8 + len;
    }
    return null;
  }
  return JSON.parse(buf.toString('utf8'));
}

// Результат кэшируется в ctx.cache: файл читают несколько правил, а он может весить
// сотни мегабайт.
function unsupportedExtensions(ctx) {
  const KEY = 'unsupportedExtensions';
  if (ctx.cache && ctx.cache.has(KEY)) return ctx.cache.get(KEY);
  let list = [];
  try {
    const json = ctx.src ? readAssetJson(ctx.src) : null;
    list = ((json && json.extensionsUsed) || []).filter((name) => !KNOWN_EXTENSIONS.has(name));
  } catch (e) {
    list = []; // файл не разобрался — этим займётся сама загрузка, здесь молчим
  }
  if (ctx.cache) ctx.cache.set(KEY, list);
  return list;
}

// Готовый отказ для правил, которые переставляют или удаляют свойства. Общий, чтобы
// причина у всех была одна и та же — человек должен увидеть одно объяснение, а не пять
// разных формулировок одной беды.
function refuseIfUnsupported(ctx) {
  const list = unsupportedExtensions(ctx);
  if (!list.length) return null;
  return { safe: false, messageId: 'unsupportedExtension.refuse', data: { list: list.join(', '), n: list.length } };
}

// Меши, на которые ссылается больше одного узла, — общая геометрия.
//
// Отличать её от обычной приходится по факту, а не по замыслу автора модели: связанные
// дубликаты Blender (Alt+D) дают её сразу, обычные копии (Ctrl+D) — после дедупликации,
// когда побайтно одинаковые меши сведены в один. Для объединения мешей это единственное,
// что важно: такой меш нельзя запечь в вершины, не размножив его на каждого владельца.
function sharedMeshes(document) {
  const shared = new Set();
  for (const mesh of document.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users++;
      if (users > 1) { shared.add(mesh); break; }
    }
  }
  return shared;
}

// Порядок пайплайна ЖЁСТКИЙ и выверен в v2 (кодируется через runAfter):
// dedup → prune → vertex-colors → weld → degenerate → orphan → (flatten+join)
// → prune → ktx2 → geometry-compress. Не менять.
export const RULES = [
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
      const out = { found: [], details: [] };
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
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'prune.safe', data: {} }; },
    async fix(finding, ctx) {
      const root = ctx.document.getRoot();
      const semBefore = listSemantics(ctx.document);
      const b = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      await ctx.document.transform(fns.prune({ keepAttributes: false, keepLeaves: false }));
      const semAfter = listSemantics(ctx.document);
      const a = { tex: root.listTextures().length, mat: root.listMaterials().length, skins: root.listSkins().length, effSkins: effectiveSkins(ctx.document) };
      const out = { found: [], details: [] };
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
      severity: 'warn', fixSafety: 'provable', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['accessor'],
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
      const out = { found: [], skipped: [], details: [] };
      const el = [];
      // Копим по атрибуту, а не отчитываемся на каждом меше: семь мешей с белым COLOR_0 —
      // это одна находка про семь мешей, а не семь находок. Ключ — сам атрибут (COLOR_0
      // и COLOR_1 смешивать нельзя) и то, что с ним решили сделать.
      const buckets = new Map(); // `${sem}|${kind}` → { sem, kind, meshes: [] }
      const note = (sem, kind, meshName) => {
        const key = `${sem}|${kind}`;
        if (!buckets.has(key)) buckets.set(key, { sem, kind, meshes: [] });
        buckets.get(key).meshes.push(meshName);
      };
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) {
            if (!sem.startsWith('COLOR_')) continue;
            const acc = prim.getAttribute(sem);
            let allWhite = true;
            const n = acc.getCount();
            for (let i = 0; i < n; i++) {
              acc.getElement(i, el); // нормализованные float-значения
              if (el.some((v) => v < 0.999)) { allWhite = false; break; }
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
      // на другом языке потребует другого слова и другого порядка (Правило 8).
      for (const b of buckets.values()) {
        const one = b.meshes.length === 1;
        const data = one
          ? { sem: b.sem, mesh: b.meshes[0] }
          : { sem: b.sem, n: b.meshes.length, list: b.meshes.join(', ') };
        const id = (base) => (one ? base : `${base}.many`);
        if (b.kind === 'white') {
          out.found.push({ messageId: id('vertexColors.found.white'), data });
          out.details.push({ messageId: id('vertexColors.done.white'), data });
        } else if (b.kind === 'stripped') {
          out.found.push({ messageId: id('vertexColors.found.painted'), data });
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
      id: 'geometry/weld', category: 'geometry', title: 'Vertex weld', titleKey: 'rule.geometryWeld',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['attributes/vertex-colors'], touches: ['geometry', 'accessor'],
      reversible: false, dataLoss: 'none', // свариваются только идентичные вершины
      // geometry-чистка идёт и при компрессии: спека Draco — «decode → run all geometry
      // optimizations → encode». Без неё draco роняет вырожденные треугольники на записи →
      // расхождение с checkpoint. Поэтому safe ИЛИ compress.
      enabled: (o) => o.safe || o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'weld.safe', data: {} }; },
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
      // два/три одинаковых индекса = нулевая площадь; считаем ПОСЛЕ weld (он их порождает).
      // Итог меряем дельтой по сцене: правка общего аксессора действует на все его инстансы.
      const trisBefore = countTriangles(ctx.document);
      const patched = new Set();
      for (const mesh of ctx.document.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          if (prim.getMode() !== 4) continue; // только TRIANGLES
          const indices = prim.getIndices();
          if (!indices || patched.has(indices)) continue;
          const arr = indices.getArray();
          const out = [];
          for (let i = 0; i + 2 < arr.length; i += 3) {
            const a = arr[i], b = arr[i + 1], c = arr[i + 2];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
          }
          if (out.length < arr.length) indices.setArray(new arr.constructor(out));
          patched.add(indices); // общий аксессор не обрабатываем дважды
        }
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
          after += prim.getAttribute('POSITION').getCount();
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
      reversalNote: 'Node hierarchy and separate parts are merged — they cannot be restored from the result. To keep parts, use --keep-parts.',
      feature: 'join', // отдельный флажок (структурно, необратимо)
      enabled: (o) => o.join,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'join.safe', data: {} }; },
    async fix(finding, ctx) {
      const m = () => { const r = collectMetrics(ctx.document, 0); return { drawCalls: r.drawCalls, nodes: r.nodes, meshes: r.meshes }; };
      // Байты ХРАНИМОЙ геометрии — не то же самое, что метрика vertices.
      // Та считает вершины как рисуемые, с учётом переиспользования мешей, и потому
      // при разворачивании общей геометрии не меняется вовсе: было «хранится один раз,
      // рисуется восемь», стало «хранится восемь раз, рисуется восемь». Рост видно
      // только здесь, в сумме буферов аксессоров.
      const geomBytes = () => {
        let n = 0;
        for (const a of ctx.document.getRoot().listAccessors()) n += a.getArray().byteLength;
        return n;
      };
      const b = m();
      const gBefore = geomBytes();

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
      await ctx.document.transform(fns.flatten());
      const shared = sharedMeshes(ctx.document);
      await ctx.document.transform(fns.join({ filter: (node) => !shared.has(node.getMesh()) }));

      const a = m();
      const gAfter = geomBytes();

      // Оставленная общая геометрия — не молчаливый отказ: человек видит меньше
      // сэкономленных отрисовок, чем ожидал, и должен знать, почему и что включить.
      const keptShared = shared.size
        ? [{ messageId: 'join.keptShared', data: { meshes: shared.size } }]
        : [];

      if (b.drawCalls > a.drawCalls || b.nodes > a.nodes || b.meshes > a.meshes) {
        const details = [{ messageId: 'join.done', data: { dcBefore: b.drawCalls, dcAfter: a.drawCalls, nodesBefore: b.nodes, nodesAfter: a.nodes } }];
        // Объединение запекает трансформ каждого узла в вершины, поэтому меш,
        // переиспользованный N раз, обязан стать N отдельными копиями. Если это
        // случилось, человек должен узнать цену прямо здесь, а не гадать, почему
        // файл вырос при неизменном числе треугольников.
        const cost = [];
        if (gAfter > gBefore * 1.05) {
          cost.push({
            messageId: 'join.expandedShared',
            data: {
              // Байты, а не готовые мегабайты: на мелкой модели «+0.0 МБ» выглядит
              // как поломка. Единицы выбирает каталог сообщений — там же, где язык.
              bytes: gAfter - gBefore,
              pct: Math.round((gAfter - gBefore) / gBefore * 100),
              dcSaved: b.drawCalls - a.drawCalls,
            },
          });
        }
        return { found: [{ messageId: 'join.found', data: { drawCalls: b.drawCalls, nodes: b.nodes } }], details, cost, skipped: keptShared };
      }
      return { skipped: keptShared };
    },
  },

  {
    meta: {
      // GPU-инстансинг: повторяющиеся меши → EXT_mesh_gpu_instancing (меньше draw calls).
      // Отдельный флажок; расширение требует поддержки декодера на целевом сайте.
      id: 'scene/instance', category: 'scene', title: 'GPU instancing', titleKey: 'rule.sceneInstance',
      severity: 'info', fixSafety: 'numeric', tier: 'basic', runAfter: ['structure/prune-unused'], touches: ['node', 'mesh'],
      reversible: true, dataLoss: 'none',
      reversalNote: 'Instancing can be expanded back to individual nodes.',
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
      await ctx.document.transform(fns.instance({ min: 2 }));
      const a = { nodes: root.listNodes().length, dc: collectMetrics(ctx.document, 0).drawCalls };
      if (a.nodes < b.nodes || a.dc < b.dc) {
        return {
          found: [`repeated meshes turned into GPU instances (EXT_mesh_gpu_instancing)`],
          details: [`GPU instancing: draw calls ${b.dc} → ${a.dc}, nodes ${b.nodes} → ${a.nodes}`],
        };
      }
      return { skipped: ['no repeated meshes to instance'] };
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
      if (!root.listAnimations().length) return { skipped: ['no animations to resample'] };
      const bytes = () => root.listAccessors().reduce((s, a) => { const arr = a.getArray(); return s + (arr ? arr.byteLength : 0); }, 0);
      const before = bytes();
      await ctx.document.transform(fns.resample());
      const after = bytes();
      if (after < before) return { details: [`Animation keyframes resampled — accessor data ${before} → ${after} bytes`] };
      return { skipped: ['no redundant keyframes to resample — animation already minimal'] };
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
    canFix(finding, ctx) { return refuseIfUnsupported(ctx) || { safe: true, messageId: 'pruneFinal.safe', data: {} }; },
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
      // ADVANCED: KTX2 требует KTX2Loader (Three.js) / поддержку basisu в движке —
      // работает не «везде», поэтому только явный opt-in (advancedFeatures:['ktx2'] / --ktx2).
      // normalizeOpts переводит выбор фичи в noKtx:false — enabled смотрит на итоговую опцию.
      id: 'textures/ktx2', category: 'textures', title: 'Textures → KTX2/UASTC', titleKey: 'rule.texturesKtx2',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'ktx2',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: true, dataLoss: 'minor', // §4d: KTX2 ↔ PNG/WebP, потеря от BASIS-U распаковки
      reversalNote: 'KTX2 can be unpacked back to PNG/WebP with a small quality loss (BASIS decoding).',
      enabled: (opts) => !opts.noKtx,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() {
      if (!TOKTX || !GLTF_CLI) {
        return { safe: false, messageId: 'ktx2.noTools', data: {} };
      }
      return { safe: true, messageId: 'ktx2.safe', data: {} };
    },
    async fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };
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
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType();
        const name = tex.getName() || '';
        if (mime === 'image/ktx2') {
          out.skipped.push({ messageId: 'ktx2.skipped.already', data: { name: name || '—' } });
          continue;
        }
        if (mime === 'image/webp' || mime === 'image/jpeg') {
          const sharp = (await import('sharp')).default; // ленивый импорт: нужен только для WebP/JPEG
          const png = await sharp(Buffer.from(tex.getImage())).png().toBuffer();
          tex.setImage(png);
          tex.setMimeType('image/png');
          toPng.set(mime, (toPng.get(mime) || 0) + 1);
        }
        const slots = fns.listTextureSlots(tex).join(' ');
        if (DATA_SLOT_RE.test(slots)) dataTex.push(name);
        else colorTex.push(name);
      }
      for (const [mime, n] of toPng) {
        out.details.push({ messageId: 'ktx2.done.toPng', data: { n, from: mime.replace('image/', '') } });
      }
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
        if (mixed) {
          if (dataTex.length) { runCli(['uastc', cur, tmpB, '--slots', DATA_SLOT_GLOB, '--level', '2', '--zstd', '18']); cur = tmpB; }
          if (colorTex.length) { runCli(['etc1s', cur, tmpC, '--slots', `!(${DATA_SLOT_GLOB})`, '--quality', '255']); cur = tmpC; }
        } else {
          runCli(['uastc', cur, tmpB, '--level', '2', '--zstd', '18']);
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
        const named = (list) => list.filter(Boolean).join(', ');
        if (colorTex.length) out.details.push({ messageId: 'ktx2.done.color', data: { n: colorTex.length, list: named(colorTex) } });
        if (dataTex.length) out.details.push({ messageId: 'ktx2.done.data', data: { n: dataTex.length, list: named(dataTex) } });
      } else {
        out.details.push({ messageId: 'ktx2.done.uastc', data: { n: needKtx } });
      }

      // Цена KTX2. На большой текстуре он выигрывает и в файле, и в видеопамяти; на
      // мелкой служебные данные контейнера весят больше самой картинки, и по файлу
      // выходит проигрыш при честном выигрыше по памяти. Замер на
      // `Draco Compressed Input 01`: 6 380 → 74 264 байта (+1064 %) при видеопамяти
      // 5.3 → 1.3 МБ (−75 %). Порог вдвое, а не «любой рост»: небольшой рост — обычная
      // плата за экономию видеопамяти, и кричать о нём значит приучить не читать.
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
      id: 'textures/webp', category: 'textures', title: 'Textures → WebP', titleKey: 'rule.texturesWebp',
      severity: 'warn', fixSafety: 'perceptual', tier: 'advanced', feature: 'webp',
      runAfter: ['structure/prune-final'], touches: ['texture'],
      reversible: true, dataLoss: 'minor',
      reversalNote: 'WebP can be decoded back to PNG, but lossy re-encoding is not undone.',
      enabled: (opts) => !opts.noWebp,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'webp.safe', data: {} }; },
    async fix(finding, ctx) {
      const out = { found: [], skipped: [], details: [] };

      // Что вообще можно кодировать. KTX2 (image/ktx2) не трогаем: это уже готовый
      // формат для видеокарты, и «сжать» его в WebP значило бы распаковать обратно.
      const CONVERTIBLE = new Set(['image/png', 'image/jpeg']);
      const cands = [];
      // Пропуски копим группами, а не пишем строкой на текстуру: на ABeautifulGame
      // это давало двадцать одинаковых строк подряд, на L-330 — одиннадцать.
      const skips = { already: [], noMime: [], jpegData: [] };
      const byFormat = new Map(); // mime без "image/" → имена текстур
      for (const tex of ctx.document.getRoot().listTextures()) {
        const mime = tex.getMimeType() || '';
        const name = tex.getName() || '—';
        if (mime === 'image/webp') { skips.already.push(name); continue; }
        // Пустой mime — не «неизвестный формат для видеокарты», а модель, которая
        // не сказала, что у неё внутри. Кодировать вслепую нельзя, и врать про
        // причину тоже: у этого случая своя строка.
        if (!mime) { skips.noMime.push(name); continue; }
        if (!CONVERTIBLE.has(mime)) {
          const short = mime.replace('image/', '');
          if (!byFormat.has(short)) byFormat.set(short, []);
          byFormat.get(short).push(name);
          continue;
        }
        // Тот же раздел, что у KTX2: нормали, occlusion и roughness — это ЧИСЛА,
        // а не картинка. Лоссовый WebP режет цветность (4:2:0) и портит вектор
        // нормали, поэтому им — только lossless, цветным — обычное сжатие.
        const isData = DATA_SLOT_RE.test(fns.listTextureSlots(tex).join(' '));
        // Карта данных, пришедшая в JPEG, — тупик в обе стороны: без потерь она
        // станет в разы тяжелее (lossless честно сохраняет и артефакты JPEG),
        // а лоссово её кодировать нельзя по той же причине, что и любую другую
        // карту данных. Оставляем как есть. Замерено на PotOfCoals: пять таких
        // карт давали +139 % к весу картинок.
        if (isData && mime === 'image/jpeg') { skips.jpegData.push(name); continue; }
        cands.push({ tex, name, mime, isData });
      }

      // Одна текстура — называем её по имени; несколько — только счёт. Перечислять
      // десяток безымянных «—» смысла нет, а строка отчёта становится нечитаемой.
      const reportSkips = (names, id, extra = {}) => {
        if (names.length === 1) out.skipped.push({ messageId: id, data: { name: names[0], ...extra } });
        else if (names.length > 1) out.skipped.push({ messageId: `${id}.many`, data: { n: names.length, ...extra } });
      };
      reportSkips(skips.already, 'webp.skipped.already');
      reportSkips(skips.noMime, 'webp.skipped.noMime');
      reportSkips(skips.jpegData, 'webp.skipped.jpegData');
      for (const [mime, names] of byFormat) reportSkips(names, 'webp.skipped.format', { mime });

      if (!cands.length) return out;

      const sharp = (await import('sharp')).default; // ленивый импорт: тот же путь, что у KTX2

      // Кодируем ПО ОДНОЙ и оставляем результат, только если он реально легче.
      // Выигрыш WebP — исключительно в размере файла (видеопамять не меняется),
      // поэтому текстура, потяжелевшая после кодирования, — это чистый проигрыш
      // без единой компенсации. Возвращаем ей исходную картинку.
      await Promise.all(cands.map(async (c) => {
        const before = c.tex.getImage();
        try {
          await fns.compressTexture(c.tex, {
            encoder: sharp, targetFormat: 'webp',
            ...(c.isData ? { lossless: true } : { quality: 90 }),
          });
        } catch (e) {
          // Битая или экзотическая картинка не должна ронять всю сборку.
          c.failed = e && e.message ? e.message : String(e);
          return;
        }
        const after = c.tex.getImage();
        if (!after || after.byteLength >= before.byteLength) {
          c.tex.setImage(before).setMimeType(c.mime);
          c.reverted = true;
        }
      }));

      // Расширение объявляем сами: transform этого больше не делает, а часть
      // текстур могла вернуться в PNG/JPEG после отката.
      const ext = ctx.document.createExtension(EXTTextureWebP);
      if (ctx.document.getRoot().listTextures().some((t) => t.getMimeType() === 'image/webp')) ext.setRequired(true);
      else ext.dispose();

      const color = cands.filter((c) => !c.isData && !c.reverted && !c.failed);
      const data = cands.filter((c) => c.isData && !c.reverted && !c.failed);
      const kept = cands.filter((c) => c.reverted);
      const failed = cands.filter((c) => c.failed);

      out.found.push({ messageId: 'webp.found', data: { n: cands.length } });
      if (color.length) out.details.push({ messageId: 'webp.done.color', data: { n: color.length } });
      if (data.length) out.details.push({ messageId: 'webp.done.data', data: { n: data.length } });
      if (kept.length) out.skipped.push({ messageId: 'webp.keptOriginal', data: { n: kept.length } });
      // Сбой кодирования — редкий и единичный случай, его называем поимённо:
      // причина у каждой текстуры своя и она нужна для разбора.
      for (const c of failed) out.skipped.push({ messageId: 'webp.skipped.failed', data: { name: c.name, reason: c.failed } });
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
      reversalNote: 'Compressed geometry unpacks back to the standard format without data loss.',
      feature: 'meshopt', // компрессия геометрии — opt-in (флажок meshopt или draco → codec)
      enabled: (o) => o.compress,
    },
    analyze() { return [{ messageId: 'pipeline', data: {} }]; },
    canFix() { return { safe: true, messageId: 'compress.safe', data: {} }; },
    async fix(finding, ctx) {
      if (ctx.opts.codec === 'draco') {
        await ctx.document.transform(fns.draco());
      } else {
        // quantizationVolume по умолчанию — 'mesh': своя область квантования на каждый меш,
        // а значит своё компенсирующее преобразование. Для скинованной модели это тупик:
        // по спецификации glTF трансформация узла со скином ИГНОРИРУЕТСЯ, поэтому компенсацию
        // приходится вносить в inverseBindMatrices — а они принадлежат скину, не мешу. Четырнадцать
        // мешей с разными областями требуют четырнадцати разных наборов IBM, и общий скин
        // расщепляется: 1 → 14. Это и есть TESTBUG-007.
        //
        // 'scene' даёт одну область на всю сцену → одно преобразование → один набор IBM.
        // Скин остаётся общим. Сжатие чуть слабее (область шире фактической у мелких мешей),
        // и платим этим только там, где иначе ломается структура.
        const hasSkins = ctx.document.getRoot().listSkins().length > 0;
        await ctx.document.transform(fns.meshopt({
          encoder: MeshoptEncoder,
          ...(hasSkins ? { quantizationVolume: 'scene' } : {}),
        }));
      }
      return { details: [{ messageId: 'compress.done', data: { codec: ctx.opts.codec } }] };
    },
  },
];
