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
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import { AUTOFIX_MAX_TIER, ENGINE_META, compareBaseline } from '../../core/engine.mjs';
import {
  BASELINE_METRICS, BASELINE_SOFT, MB, collectMetrics, baselineSnapshot,
} from './metrics.mjs';
import { RULES } from './rules.mjs';
import { TOKTX } from './tools.mjs';

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
const ADVANCED_FEATURES = {
  ktx2: 'текстуры → KTX2 (нужна поддержка в браузере/движке)',
  draco: 'сжатие геометрии Draco вместо Meshopt',
  'strip-colors': 'удаление раскрашенных вершинных цветов (lossy)',
};

// Значения по умолчанию — ровно как у CLI без флагов (контракт §4b): ТОЛЬКО базовые
// оптимизации, расширения — через advancedFeatures. Неизвестная фича → Error
// (optimizeFile превратит его в status:'fail', а не молча проигнорирует).
function normalizeOpts(opts = {}) {
  const adv = [...new Set((opts.advancedFeatures || []).map(String))];
  const unknown = adv.filter((f) => !(f in ADVANCED_FEATURES));
  if (unknown.length) {
    throw new Error(`Неизвестные advancedFeatures: ${unknown.join(', ')}. Доступные: ${Object.keys(ADVANCED_FEATURES).join(', ')}.`);
  }
  return {
    advancedFeatures: adv,
    // фича 'draco' переключает кодек; явный codec:'draco' (legacy) тоже работает
    codec: opts.codec === 'draco' || adv.includes('draco') ? 'draco' : 'meshopt',
    texMode: opts.texMode === 'uastc' ? 'uastc' : 'mixed',
    keepParts: !!opts.keepParts,
    // KTX2 с v0.0.8 по умолчанию ВЫКЛЮЧЕН (advanced). Приоритет: фича 'ktx2' >
    // явный boolean noKtx (legacy-вызовы с noKtx:false сохраняют смысл) > default true.
    // Фича обязана побеждать: baseline-профили передают noKtx:true, а web-interface
    // добавляет advancedFeatures поверх них — иначе KTX2 не включить вовсе.
    noKtx: adv.includes('ktx2') ? false : (typeof opts.noKtx === 'boolean' ? opts.noKtx : true),
    stripColors: !!opts.stripColors || adv.includes('strip-colors'),
    dryRun: !!opts.dryRun,
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
  if (before.triangles === 0) vp('info', 'треугольной геометрии не было и нет');
  else if (after.triangles > 0) vp('pass', 'геометрия на месте');
  else vp('fail', 'ГЕОМЕТРИЯ ПУСТАЯ — файл битый!');
  // 2. треугольники не изменились (кроме вырожденных); окно отсчёта — как в v2 (до weld)
  const trianglesBase = ctx.cache.get('trianglesBeforeWeld') ?? before.triangles;
  const degenerateRemoved = ctx.cache.get('degenerateRemoved') ?? 0;
  const triangleDelta = trianglesBase - after.triangles;
  if (triangleDelta === 0) vp('pass', 'число треугольников не изменилось');
  else if (triangleDelta === degenerateRemoved) vp('info', `треугольников стало меньше на ${triangleDelta} — только вырожденные (нулевая площадь), рендер идентичен`);
  else vp('fail', `треугольники расходятся: ожидали ${trianglesBase - degenerateRemoved}, получили ${after.triangles}`);
  // 2b. BASELINE-CHECKPOINT — строгая сверка структуры со снимком после базового прохода (движок)
  for (const line of compareBaseline(ctx.baselineMetrics, after, BASELINE_METRICS, { advancedPlannedIds, log, soft: BASELINE_SOFT })) v.push(line);
  // 3-5. анимации, скины, сцены
  if (before.animations === after.animations) vp('pass', `анимации: ${after.animations}`);
  else vp('fail', `анимации потеряны: было ${before.animations}, стало ${after.animations}`);
  if (before.skins === after.skins) vp('pass', `действующие скины: ${after.skins}`);
  else vp('fail', `скины потеряны: было ${before.skins}, стало ${after.skins}`);
  if (before.scenes === after.scenes) vp('pass', `иерархия сцен цела: ${after.scenes}`);
  else vp('fail', `сцены потеряны: было ${before.scenes}, стало ${after.scenes}`);
  // 6. bounding box в пределах эпсилон (квантование кодека даёт микросдвиг — допуск 1% диагонали)
  if (before.bounds && after.bounds) {
    const diag = Math.hypot(...[0, 1, 2].map((i) => before.bounds.max[i] - before.bounds.min[i]));
    const eps = Math.max(1e-6, diag * 0.01);
    const ok = [0, 1, 2].every((i) =>
      Math.abs(before.bounds.min[i] - after.bounds.min[i]) <= eps && Math.abs(before.bounds.max[i] - after.bounds.max[i]) <= eps);
    if (ok) vp('pass', 'bounding box в пределах эпсилон');
    else vp('fail', 'bounding box изменился — модель съехала или схлопнулась');
  } else {
    vp('info', 'bounding box не посчитан (getBounds недоступен или нет сцены)');
  }
  // 7. материалы
  if (materialsOk) vp('pass', 'каждый материал резолвится');
  else vp('fail', 'примитив ссылается на удалённый материал');
  // 8. gltf-validator (Khronos)
  try {
    const validator = await import('gltf-validator');
    const res = await validator.validateBytes(new Uint8Array(glbBytes));
    const errs = res.issues.numErrors;
    if (errs === 0) {
      vp('pass', 'gltf-validator (Khronos): 0 ошибок');
    } else {
      // вход мог быть битым изначально — проверяем исходник и блокируем только НОВЫЕ ошибки
      const inRes = await validator.validateBytes(new Uint8Array(fs.readFileSync(src)));
      const inErrs = inRes.issues.numErrors;
      if (inErrs > 0) addFound(ENGINE_META.inputValidation, `входной файл уже содержит ${inErrs} ошибок gltf-validator (дефект экспорта, не оптимизации)`);
      if (errs <= inErrs) {
        vp('info', `gltf-validator: осталось ${errs} ошибок, унаследованных от входа (в исходнике ${inErrs}) — оптимизация новых не добавила`);
        for (const m of res.issues.messages.filter((m) => m.severity === 0).slice(0, 3)) {
          vp('info', `пример: ${m.code} @ ${m.pointer || '—'}`);
        }
      } else {
        vp('fail', `gltf-validator: ${errs} ошибок (на входе было ${inErrs}) — оптимизация добавила новые`);
      }
    }
  } catch {
    vp('info', 'gltf-validator не установлен — структурная валидация пропущена');
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
  const flags = (opts.keepParts ? ' · без join' : '')
    + (opts.noKtx ? ' · без KTX2' : ` · текстуры: ${opts.texMode}`)
    + (opts.stripColors ? ' · strip-vertex-colors' : '')
    + (opts.dryRun ? ' · **DRY-RUN**' : '');
  const lines = [
    `# Отчёт оптимизации — ${name}`,
    '',
    `Дата: ${new Date().toISOString().slice(0, 10)} · кодек: ${opts.codec} · автофикс: до «${AUTOFIX_MAX_TIER}»${flags}`,
    '',
    '## Найдено (проблемы)',
    '',
    ...(report.findings.length ? report.findings.map((f) => `- ✓ ${f.text}`) : ['- индивидуальных находок нет (структурная чистка без замечаний)']),
    '',
    '## Пропущено (и почему)',
    '',
    ...(report.skipped.length ? report.skipped.map((s) => `- ${s.text}`) : ['- нет']),
    '',
    '## Применено',
    '',
    ...(report.applied.length ? report.applied.map((a) => `- ${a.text}`) : ['- нет']),
    '',
    '## Валидация',
    '',
    ...report.validation.map((s) => `- ${LEVEL_PREFIX[s.level]} ${s.text}`),
    ...(assetWritten ? [] : [
      '',
      opts.dryRun
        ? '**Режим dry-run** — файл .glb не записан; отчёт показывает, что БЫЛО БЫ сделано (все фазы прогнаны в памяти, цифры точные).'
        : '**Файл .glb НЕ записан** — не было применённых фиксов или валидация не прошла.',
    ]),
    '',
    '## Оценка улучшений',
    '',
    '| Показатель | До | После |',
    '|---|---|---|',
    diffLine('Файл', before.fileBytes, after.fileBytes, (v) => `${MB(v)} МБ`),
    diffLine('VRAM текстур (GPU)', before.gpuBytes, after.gpuBytes, (v) => `${MB(v)} МБ`),
    diffLine('Вес текстур в файле', before.textureBytes, after.textureBytes, (v) => `${MB(v)} МБ`),
    diffLine('Draw calls (примитивы)', before.drawCalls, after.drawCalls),
    diffLine('Треугольники', before.triangles, after.triangles),
    diffLine('Вершины', before.vertices, after.vertices),
    diffLine('Меши', before.meshes, after.meshes),
    diffLine('Материалы', before.materials, after.materials),
    diffLine('Текстуры', before.textures, after.textures),
    diffLine('Узлы сцены', before.nodes, after.nodes),
    '',
  ];
  // dry-run пишет отчёт под отдельным именем, чтобы не затирать отчёт реального прогона
  const reportName = name.replace(/\.(glb|gltf)$/i, opts.dryRun ? '.dryrun.report.md' : '.report.md');
  fs.writeFileSync(path.join(opts.outDir, reportName), lines.join('\n'), 'utf8');
  return reportName;
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
};

export default gltfAddon;
