// addons/gltf/index.mjs — аддон формата glTF/GLB. Всегда включён и невыключаем (Фаза C):
// единственный формат ядра. Собирает воедино правила (rules.mjs), метрики (metrics.mjs)
// и внешний тулинг (tools.mjs) и отдаёт движку (core/engine.mjs) набор хуков формата:
//   formats · outputName · rules · BASELINE_METRICS · normalizeOpts · createIO ·
//   load · writeBytes · readBytes · collectMetrics · baselineMetrics ·
//   stripInputCompression · validate · writeReport
//
// Draco/Meshopt/KTX2 работают ТОЛЬКО с Document из @gltf-transform/core — это конкретные
// glTF-расширения, поэтому весь их код живёт здесь, одним пакетом (не дробится на
// addons/draco|meshopt|textures — резать по meta.category можно позже, при втором формате).

import fs from 'node:fs';
import path from 'node:path';

import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from '../../core/engine.mjs';
import { register } from '../../core/i18n.mjs';
import {
  BASELINE_METRICS, BASELINE_SOFT, MB, collectMetrics, baselineSnapshot,
} from './metrics.mjs';
import enMessages from './messages/en.mjs';
import { RULES } from './rules.mjs';
import { TOKTX } from './tools.mjs';

// Регистрируем английский каталог правил при импорте аддона (единственный сейчас язык).
register('en', enMessages);

const { NodeIO } = gltfCore;

// io с декодерами создаётся один раз и переиспользуется всеми вызовами
let _ioPromise = null;
function createIO() {
  if (!_ioPromise) {
    _ioPromise = (async () => {
      await MeshoptEncoder.ready;
      await MeshoptDecoder.ready;
      return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
          'draco3d.decoder': await draco3d.createDecoderModule(),
          'draco3d.encoder': await draco3d.createEncoderModule(),
          'meshopt.decoder': MeshoptDecoder,
          'meshopt.encoder': MeshoptEncoder,
        });
    })();
  }
  return _ioPromise;
}

// Расширенные возможности (tier advanced): id → человекочитаемое имя для ошибок.
// Каждая фича транслируется в конкретную опцию ядра ниже в normalizeOpts.
// v0.1.1: ВСЁ — opt-in. По умолчанию ничего не делаем (passthrough); каждая оптимизация
// включается своим флажком (advancedFeatures). Флажок может бандлить много правил (safe).
const ADVANCED_FEATURES = {
  safe: 'safe lossless cleanup: dedup, prune unused, weld, remove degenerate/orphan geometry',
  meshopt: 'Meshopt geometry compression',
  draco: 'Draco geometry compression (instead of Meshopt)',
  join: 'join meshes / flatten scene — fewer draw calls (structural, irreversible)',
  instance: 'GPU instancing (EXT_mesh_gpu_instancing) — repeated meshes as instances',
  resample: 'resample animations — drop redundant keyframes (lossless)',
  ktx2: 'textures → KTX2 (needs browser/engine support)',
  'strip-colors': 'removal of painted vertex colors (lossy)',
};

// Значения по умолчанию — ровно как у CLI без флагов (контракт §4b): ТОЛЬКО базовые
// оптимизации, расширения — через advancedFeatures. Неизвестная фича → Error
// (optimizeFile превратит его в status:'fail', а не молча проигнорирует).
function normalizeOpts(opts = {}) {
  const adv = [...new Set((opts.advancedFeatures || []).map(String))];
  const unknown = adv.filter((f) => !(f in ADVANCED_FEATURES));
  if (unknown.length) {
    throw new Error(`Unknown advancedFeatures: ${unknown.join(', ')}. Available: ${Object.keys(ADVANCED_FEATURES).join(', ')}.`);
  }
  // Компрессия геометрии — opt-in: флажок 'meshopt' или 'draco' (либо legacy codec/compress).
  const draco = opts.codec === 'draco' || adv.includes('draco');
  const compress = draco || adv.includes('meshopt') || !!opts.compress;

  return {
    advancedFeatures: adv,
    // opt-in-флаги: по умолчанию всё выключено (passthrough).
    safe: adv.includes('safe') || !!opts.safe, // безопасная чистка (бандл)
    compress, // сжимать ли геометрию вообще
    codec: draco ? 'draco' : 'meshopt', // какой кодек — если compress включён
    join: (adv.includes('join') || !!opts.join) && !opts.keepParts, // склейка мешей — отдельный флажок
    instance: adv.includes('instance') || !!opts.instance, // GPU-инстансинг (нужен декодер на сайте)
    resample: adv.includes('resample') || !!opts.resample, // чистка кадров анимации (без потерь)
    // KTX2-режим: UASTC по умолчанию (самый безопасный/качественный для новичков);
    // ETC1S (максимальное сжатие) — texMode:'mixed' (ETC1S цвет + UASTC data-карты).
    texMode: opts.texMode === 'mixed' ? 'mixed' : 'uastc',
    keepParts: !!opts.keepParts,
    // KTX2 по умолчанию ВЫКЛЮЧЕН (advanced). Приоритет: фича 'ktx2' > явный boolean noKtx
    // (legacy) > default true.
    noKtx: adv.includes('ktx2') ? false : (typeof opts.noKtx === 'boolean' ? opts.noKtx : true),
    stripColors: !!opts.stripColors || adv.includes('strip-colors'),
    dryRun: !!opts.dryRun,
    // §4b: opts.locale можно добавлять свободно (default 'en'). Неизвестная локаль
    // всплывёт ошибкой рендера при первом сообщении (→ status:'fail'), а не пустой строкой.
    locale: typeof opts.locale === 'string' ? opts.locale : 'en',
    outDir: path.resolve(String(opts.outDir || 'output')),
    force: !!opts.force,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    // аддитивная опция (не в контракте, разрешено правилами стабильности): приёмник
    // строк хода работы. По умолчанию тишина; CLI передаёт console.log.
    log: typeof opts.log === 'function' ? opts.log : () => {},
  };
}

function outputName(src) {
  return path.basename(src).replace(/\.gltf$/i, '.glb');
}

const load = (io, src) => io.read(src);
const writeBytes = (io, doc) => io.writeBinary(doc);
const readBytes = (io, bytes) => io.readBinary(bytes);

// Входное сжатие геометрии (Draco/Meshopt) снимаем сразу после загрузки — иначе каждая
// запись молча пережимает геометрию заново (ARCHITECTURE.md §6). Возвращаем имена снятых
// кодеков — движок отражает их в отчёте (engine/input-compression).
function stripInputCompression(doc) {
  const stripped = [];
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression' || ext.extensionName === 'EXT_meshopt_compression') {
      stripped.push(ext.extensionName);
      ext.dispose();
    }
  }
  return stripped;
}

// -------- ФАЗА 4 · валидация всего ассета (специфична для glTF) --------
// Наполняет result.validation в порядке отчёта; baseline-checkpoint (2b) считает движок
// (compareBaseline). При любом level:'fail' движок не записывает .glb.
async function validate({ ctx, before, after, glbBytes, src, result, advancedPlannedIds, addFound, log }) {
  const v = result.validation;
  const vp = (level, text) => v.push({ level, text }); // md-отчёт рендерит ✅/ℹ/❌ из level

  // материалы резолвятся: ни один примитив не ссылается на удалённый материал
  let materialsOk = true;
  for (const mesh of ctx.document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat && typeof mat.isDisposed === 'function' && mat.isDisposed()) materialsOk = false;
    }
  }

  // 1. геометрия на месте
  if (before.triangles === 0) vp('info', 'no triangle geometry before or after');
  else if (after.triangles > 0) vp('pass', 'geometry is present');
  else vp('fail', 'GEOMETRY IS EMPTY — broken file!');
  // 2. треугольники не изменились (кроме вырожденных); окно отсчёта — как в v2 (до weld)
  const trianglesBase = ctx.cache.get('trianglesBeforeWeld') ?? before.triangles;
  const degenerateRemoved = ctx.cache.get('degenerateRemoved') ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) vp('pass', 'triangle count unchanged');
  else if (triangleDelta === degenerateRemoved) vp('info', `triangle count dropped by ${triangleDelta} — only degenerate ones (zero area), render is identical`);
  else vp('fail', `triangle mismatch: expected ${trianglesBase - degenerateRemoved}, got ${after.triangles}`);
  // 2b. BASELINE-CHECKPOINT — строгая сверка структуры со снимком после базового прохода (движок)
  for (const line of compareBaseline(ctx.baselineMetrics, after, BASELINE_METRICS, { advancedPlannedIds, log, soft: BASELINE_SOFT })) v.push(line);
  // 3-5. анимации, скины, сцены
  if (before.animations === after.animations) vp('pass', `animations: ${after.animations}`);
  else vp('fail', `animations lost: was ${before.animations}, now ${after.animations}`);
  if (before.skins === after.skins) vp('pass', `effective skins: ${after.skins}`);
  else vp('fail', `skins lost: was ${before.skins}, now ${after.skins}`);
  if (before.scenes === after.scenes) vp('pass', `scene hierarchy intact: ${after.scenes}`);
  else vp('fail', `scenes lost: was ${before.scenes}, now ${after.scenes}`);
  // 6. bounding box в пределах эпсилон (квантование кодека даёт микросдвиг — допуск 1% диагонали)
  if (before.bounds && after.bounds) {
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds.max[i] - before.bounds.min[i]));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds.min[i] - after.bounds.min[i]) <= eps && Math.abs(before.bounds.max[i] - after.bounds.max[i]) <= eps);
    if (ok) vp('pass', 'bounding box within epsilon');
    // @gltf-transform/core getBounds() не умеет EXT_mesh_gpu_instancing (не учитывает
    // per-instance трансформы) — после реального инстансинга даёт заведомо неверные
    // числа, хотя рендер не меняется. Не блокируем запись в этом единственном известном
    // случае — только информируем; иначе (без инстансинга) расхождение остаётся fail.
    else if (result.applied.some((a) => a.ruleId === 'scene/instance')) {
      vp('info', 'bounding box check skipped after GPU instancing — getBounds() does not support EXT_mesh_gpu_instancing');
    } else vp('fail', 'bounding box changed — model shifted or collapsed');
  } else {
    vp('info', 'bounding box not computed (getBounds unavailable or no scene)');
  }
  // 7. материалы
  if (materialsOk) vp('pass', 'every material resolves');
  else vp('fail', 'a primitive references a deleted material');
  // 8. gltf-validator (Khronos)
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glbBytes));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      vp('pass', 'gltf-validator (Khronos): 0 errors');
    } else {
      // вход мог быть битым изначально — проверяем исходник и блокируем только НОВЫЕ ошибки
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      if (inErrs > 0) addFound(ENGINE_META.inputValidation, `the input file already has ${inErrs} gltf-validator errors (an export defect, not the optimization)`);
      if (errs <= inErrs) {
        vp('info', `gltf-validator: ${errs} errors remain, inherited from the input (${inErrs} in the source) — optimization added none`);
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          vp('info', `example: ${m.code} @ ${m.pointer || '—'}`);
        }
      } else {
        vp('fail', `gltf-validator: ${errs} errors (input had ${inErrs}) — optimization added new ones`);
      }
    }
  } catch {
    vp('info', 'gltf-validator not installed — structural validation skipped');
  }
}

// -------- ФАЗА 5 · отчёт (централизованно из данных RunResult, специфичен для glTF) --------
function diffLine(label, before, after, fmt = (v) => v) {
  return `| ${label} | ${fmt(before)} | ${fmt(after)} |`;
}

// уровень → префикс строки валидации в md (разбор обратно: level хранится в RunResult)
const LEVEL_PREFIX = { pass: '✅', info: 'ℹ', fail: '❌' };

function writeReport({ name, result, before, after, assetWritten, opts }) {
  const report = result;
  const flags = (opts.keepParts ? ' · no join' : '')
    + (opts.noKtx ? ' · no KTX2' : ` · textures: ${opts.texMode}`)
    + (opts.stripColors ? ' · strip-vertex-colors' : '')
    + (opts.dryRun ? ' · **DRY-RUN**' : '');
  const lines = [
    `# Optimization report — ${name}`,
    '',
    `Date: ${new Date().toISOString().slice(0, 10)} · codec: ${opts.codec} · autofix: up to "${AUTOFIX_MAX_TIER}"${flags}`,
    '',
    '## Found (issues)',
    '',
    ...(report.findings.length ? report.findings.map((f) => `- ✓ ${f.text}`) : ['- no individual findings (structural cleanup with nothing to note)']),
    '',
    '## Skipped (and why)',
    '',
    ...(report.skipped.length ? report.skipped.map((s) => `- ${s.text}`) : ['- none']),
    '',
    '## Applied',
    '',
    ...(report.applied.length ? report.applied.map((a) => `- ${a.text}`) : ['- none']),
    '',
    '## Validation',
    '',
    ...report.validation.map((s) => `- ${LEVEL_PREFIX[s.level]} ${s.text}`),
    ...(assetWritten ? [] : [
      '',
      opts.dryRun
        ? '**Dry-run mode** — the .glb was not written; the report shows what WOULD have been done (all phases ran in memory, numbers are exact).'
        : '**The .glb was NOT written** — validation failed (see Validation below).',
    ]),
    '',
    '## Estimated improvements',
    '',
    '| Metric | Before | After |',
    '|---|---|---|',
    diffLine('File', before.fileBytes, after.fileBytes, (v) => `${MB(v)} MB`),
    diffLine('Texture VRAM (GPU)', before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} MB`),
    diffLine('Texture weight in file', before.textureBytes, after.textureBytes, (v) => `${MB(v)} MB`),
    diffLine('Draw calls (primitives)', before.drawCalls, after.drawCalls),
    diffLine('Triangles', before.triangles, after.triangles),
    diffLine('Vertices', before.vertices, after.vertices),
    diffLine('Meshes', before.meshes, after.meshes),
    diffLine('Materials', before.materials, after.materials),
    diffLine('Textures', before.textures, after.textures),
    diffLine('Scene nodes', before.nodes, after.nodes),
    '',
  ];
  // dry-run пишет отчёт под отдельным именем, чтобы не затирать отчёт реального прогона
  const reportName = name.replace(/\.(glb|gltf)$/i, opts.dryRun ? '.dryrun.report.md' : '.report.md');
  fs.writeFileSync(path.join(opts.outDir, reportName), lines.join('\n'), 'utf8');
  return reportName;
}

// -------- Слепые зоны Khronos-валидатора --------
// Валидатор не умеет часть расширений и честно сообщает об этом (UNSUPPORTED_EXTENSION).
// Побочный эффект: ссылки, лежащие ВНУТРИ такого расширения, он не видит — и помечает живые
// объекты как UNUSED_OBJECT; данные в неизвестном ему контейнере — как дефект формата. Ни то,
// ни другое не является проблемой модели: она грузится движком с нужным декодером.
//
// Мы знаем, где именно каждое расширение прячет ссылки, поэтому помечаем такие сообщения
// полем `explainedBy: '<имя расширения>'`. Сообщения НЕ удаляются — данные валидатора остаются
// полностью, а UI показывает их отдельной свёрнутой группой и не считает за проблемы.
// Проверено на реальных сборках: draco прячет bufferViews, meshopt — buffers,
// EXT_mesh_gpu_instancing — accessors, KHR_texture_basisu — images (+ mime image/ktx2).

// JSON-чанк РОВНО тех байтов, которые проверял валидатор: пере-сериализация документа дала бы
// другие индексы, и указатели сообщений (`/bufferViews/3`) перестали бы совпадать.
function parseGltfJson(bytes) {
  try {
    const GLB_MAGIC = 0x46546c67;
    if (bytes.length >= 20 && bytes.readUInt32LE(0) === GLB_MAGIC) {
      const jsonLength = bytes.readUInt32LE(12);
      return JSON.parse(bytes.slice(20, 20 + jsonLength).toString('utf8'));
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null; // не разобрали — просто не объясняем сообщения
  }
}

// Индекс объекта → имя расширения, которое на него ссылается (и которое валидатор не читает).
function referencesHiddenInExtensions(json, unsupported) {
  const refs = { bufferViews: new Map(), buffers: new Map(), accessors: new Map(), images: new Map() };
  const add = (kind, index, ext) => { if (Number.isInteger(index)) refs[kind].set(index, ext); };

  if (unsupported.has('KHR_draco_mesh_compression')) {
    // сжатая геометрия: у accessors нет bufferView, данные лежат в буфере расширения
    for (const mesh of json.meshes || []) {
      for (const prim of mesh.primitives || []) {
        const d = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
        if (d) add('bufferViews', d.bufferView, 'KHR_draco_mesh_compression');
      }
    }
  }
  if (unsupported.has('EXT_meshopt_compression')) {
    for (const bv of json.bufferViews || []) {
      const m = bv.extensions && bv.extensions.EXT_meshopt_compression;
      if (m) add('buffers', m.buffer, 'EXT_meshopt_compression');
    }
  }
  if (unsupported.has('EXT_mesh_gpu_instancing')) {
    // per-instance TRANSLATION/ROTATION/SCALE — обычные accessors, но видны только изнутри
    for (const node of json.nodes || []) {
      const i = node.extensions && node.extensions.EXT_mesh_gpu_instancing;
      for (const idx of Object.values((i && i.attributes) || {})) add('accessors', idx, 'EXT_mesh_gpu_instancing');
    }
  }
  if (unsupported.has('KHR_texture_basisu')) {
    for (const tex of json.textures || []) {
      const b = tex.extensions && tex.extensions.KHR_texture_basisu;
      if (b) add('images', b.source, 'KHR_texture_basisu');
    }
  }
  return refs;
}

// Какое расширение объясняет это сообщение (или null, если сообщение настоящее).
function explanationFor(message, refs, json, unsupported) {
  const pointer = String(message.pointer || '');

  if (message.code === 'UNUSED_OBJECT') {
    const hit = /^\/(bufferViews|buffers|accessors|images)\/(\d+)$/.exec(pointer);
    if (hit) return refs[hit[1]].get(Number(hit[2])) || null;
    return null;
  }

  // KTX2: базовая спека не знает mime image/ktx2 и не умеет прочитать такой контейнер —
  // оба сообщения появляются ровно потому, что расширение не поддержано.
  if (unsupported.has('KHR_texture_basisu')) {
    const images = json.images || [];
    const isKtx2 = (i) => images[i] && images[i].mimeType === 'image/ktx2';
    const mime = /^\/images\/(\d+)\/mimeType$/.exec(pointer);
    if (message.code === 'VALUE_NOT_IN_LIST' && mime && isKtx2(Number(mime[1]))) return 'KHR_texture_basisu';
    const img = /^\/images\/(\d+)$/.exec(pointer);
    if (message.code === 'IMAGE_UNRECOGNIZED_FORMAT' && img && isKtx2(Number(img[1]))) return 'KHR_texture_basisu';
  }
  return null;
}

// Имя расширения из текста «Cannot validate an extension ... : '<name>'.» (см. ISSUES.md
// валидатора — формат сообщения с именем в кавычках стабилен для UNSUPPORTED_EXTENSION).
function unsupportedExtName(message) {
  const hit = /'([^']+)'/.exec(message.message || '');
  return hit ? hit[1] : null;
}

function explainValidatorBlindSpots(json, messages) {
  if (!json || !messages.length) return messages;
  const unsupported = new Set();
  for (const m of messages) {
    if (m.code !== 'UNSUPPORTED_EXTENSION') continue;
    const name = unsupportedExtName(m);
    if (name) unsupported.add(name);
  }
  if (!unsupported.size) return messages;

  const refs = referencesHiddenInExtensions(json, unsupported);
  return messages.map((m) => {
    // сама строка «расширение не поддержано» — не дефект, а объяснение остальных; в ту же группу
    if (m.code === 'UNSUPPORTED_EXTENSION') {
      const name = unsupportedExtName(m);
      return name ? { ...m, explainedBy: name } : m;
    }
    const by = explanationFor(m, refs, json, unsupported);
    return by ? { ...m, explainedBy: by } : m;
  });
}

// -------- Инспекция ассета (Metadata + Validation, как на gltf.report) --------
// Формат-специфично: метаданные из fns.inspect (те же таблицы, что у gltf.report) +
// issues от Khronos gltf-validator. Ядро отдаёт это через inspectFile() формат-агностично;
// будущий аддон другого формата реализует тот же хук со своими данными.
async function inspect(srcPath) {
  const io = await createIO();
  const bytes = fs.readFileSync(srcPath);
  const doc = await io.read(srcPath);
  const asset = doc.getRoot().getAsset() || {};
  const extensions = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);

  let metadata = { scenes: { properties: [] }, meshes: { properties: [] }, materials: { properties: [] }, textures: { properties: [] }, animations: { properties: [] } };
  try { metadata = fns.inspect(doc); } catch { /* экзотика — отдаём пустые таблицы */ }

  let validation = [];
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(bytes));
    validation = (res && res.issues && res.issues.messages) || [];
    // пометить сообщения, вызванные слепотой валидатора к расширениям (не удаляя их)
    validation = explainValidatorBlindSpots(parseGltfJson(bytes), validation);
  } catch { /* валидатор не установлен — пустой список */ }

  return {
    format: 'gltf',
    asset: { version: asset.version || '', generator: asset.generator || '' },
    extensions,
    metadata,
    validation,
  };
}

// -------- Экспорт glTF как самодостаточного JSON (как «Export → JSON» на gltf.report) --------
// Буферы/изображения инлайнятся data-URI, чтобы получился один JSON без внешних файлов.
function mimeFromUri(uri) {
  const ext = (String(uri).split('.').pop() || '').toLowerCase();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    ktx2: 'image/ktx2', bin: 'application/octet-stream',
  }[ext] || 'application/octet-stream';
}

async function toJSON(srcPath) {
  const io = await createIO();
  const doc = await io.read(srcPath);
  const { json, resources } = await io.writeJSON(doc, {});
  const inline = (uri, mime) => {
    const bytes = resources && resources[uri];
    if (!bytes) return uri;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  };
  for (const b of json.buffers || []) if (b.uri) b.uri = inline(b.uri, 'application/octet-stream');
  for (const img of json.images || []) if (img.uri) img.uri = inline(img.uri, img.mimeType || mimeFromUri(img.uri));
  return json;
}

/** @type {import('../../core/types.mjs').Addon} */
const gltfAddon = {
  formats: ['glb', 'gltf'],
  rules: RULES,
  BASELINE_METRICS,
  ADVANCED_FEATURES,
  TOKTX, // для CLI-баннера (наличие toktx)
  outputName,
  normalizeOpts,
  createIO,
  load,
  writeBytes,
  readBytes,
  collectMetrics,
  baselineMetrics: baselineSnapshot,
  stripInputCompression,
  validate,
  writeReport,
  inspect,
  toJSON,
};

export default gltfAddon;
