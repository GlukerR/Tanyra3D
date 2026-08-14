// tests/helpers/model-situations.mjs — реестр СИТУАЦИЙ (классов моделей).
//
// Задание 2026-08-03-классы-моделей, ПРАВИЛА_ТЕСТОВ_универсальность.md §3:
// параметризуй по СИТУАЦИИ, а не по имени модели. Имя — способ получить
// представителя класса, и он может смениться (придёт Babylon — ситуации останутся).
//
// Класс распознаётся ПО ФАЙЛУ: хелпер читает модель и сам решает, к каким классам
// она относится. Список представителей нигде не переписывается руками — он
// вычисляется обходом fixtures/models/ и тем же распознаванием. Поэтому добавление
// новой модели в корпус автоматически обновляет и `situationsOf`, и `modelsWith`.
//
// Формат-независимость: классы описаны в терминах glTF (треугольники, скины,
// текстуры, расширения) — это свойства ФАЙЛА (Слой 2), а не конкретного движка.
// Имена движков здесь не встречаются.
//
// Распознавание читает документ через ТОТ ЖЕ io, что и аддон (с декодерами
// Draco/Meshopt): «скины» считаются как в addons/gltf/metrics.mjs — действующие
// (effectiveSkins), а не просто объявленные.
//
// ВАЖНО про vitest-глобалы: describe/it доступны только в test-файлах. Helper —
// обычный ESM-модуль, глобалов в нём нет — явный импорт `it` из 'vitest'.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

import gltfAddon from '../../addons/gltf/index.mjs';
import { effectiveSkins, sceneGeometry } from '../../addons/gltf/metrics.mjs';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { modelPath, REPO_MODELS } from './model-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'models');

// Расширения, которые библиотека знает: всё остальное, объявленное в файле, — это
// класс `unknown-extension` (тот же список, что у правил в addons/gltf/rules.mjs).
const KNOWN_EXTENSIONS = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

// «Тяжёлая» модель — больше ~50 МБ (класс heavy).
const HEAVY_BYTES = 50 * 1024 * 1024;

// Кириллица, пробелы или спецсимволы в имени файла → класс `edge-name`.
const EDGE_NAME_RE = /[а-яА-ЯёЁ]|\s|[^\x20-\x7E]/;

// JSON-чанк файла (GLB: первый чанк; .gltf: сам JSON). Нужен для неизвестных
// расширений: библиотека при загрузке отбрасывает их, и по документу их уже не
// увидеть — только по сырому файлу.
function readAssetJson(srcPath) {
  const buf = fs.readFileSync(srcPath);
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

/** Число мешей, на которые ссылаются ≥2 узла, — «общая геометрия» (shared-geometry). */
function sharedMeshCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    let users = 0;
    for (const parent of mesh.listParents()) {
      if (parent.propertyType === 'Node') users += 1;
      if (users > 1) { n += 1; break; }
    }
  }
  return n;
}

/** Набор семантик атрибутов примитивов (COLOR_0, TEXCOORD_1, …). */
function attributeSemantics(doc) {
  const out = new Set();
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  }
  return out;
}

/** Классы ОДНОЙ модели — вычисляются по файлу, не переписываются руками. */
async function situationsOfFile(name) {
  const classes = [];
  if (EDGE_NAME_RE.test(name)) classes.push('edge-name');

  let json;
  try {
    if (fs.statSync(modelPath(name)).size > HEAVY_BYTES) classes.push('heavy');
    json = readAssetJson(modelPath(name));
  } catch {
    // Файл не разбирается даже на уровне JSON — битый.
    classes.push('broken');
    return classes;
  }

  const io = await gltfAddon.createIO();
  let doc;
  try {
    doc = await io.read(modelPath(name));
  } catch {
    // Документ не читается (битый GLB) — отдельный класс, не исключение наружу.
    classes.push('broken');
    return classes;
  }
  const root = doc.getRoot();
  const geo = sceneGeometry(doc);
  const textures = root.listTextures();
  const used = new Set(root.listExtensionsUsed().map((e) => e.extensionName));
  const declared = new Set(json.extensionsUsed || []);
  const unknown = [...declared].filter((x) => !KNOWN_EXTENSIONS.has(x));

  if (geo.triangles === 0) classes.push('no-geometry');
  if (textures.length === 0) classes.push('no-textures');
  if (textures.length > 0 && geo.triangles === 0) classes.push('textures-only');
  if (effectiveSkins(doc) >= 1) classes.push('skinned');
  if (geo.morphTargets >= 1) classes.push('morphed');
  if (root.listAnimations().length >= 1) classes.push('animated');
  if (sharedMeshCount(doc) >= 1) classes.push('shared-geometry');
  if (used.has('EXT_mesh_gpu_instancing')) classes.push('preinstanced');
  if (used.has('KHR_draco_mesh_compression')) classes.push('precompressed-draco');
  if (used.has('EXT_meshopt_compression')) classes.push('precompressed-meshopt');
  if (used.has('KHR_mesh_quantization')) classes.push('prequantized');
  const mimes = textures.map((t) => t.getMimeType() || '');
  if (mimes.includes('image/webp')) classes.push('pre-webp');
  if (mimes.includes('image/ktx2')) classes.push('pre-ktx2');
  if (attributeSemantics(doc).has('COLOR_0')) classes.push('vertex-colors');
  if (root.listScenes().length >= 2) classes.push('multi-scene');
  if (unknown.length) classes.push('unknown-extension');

  return classes;
}

// ---------- вычисление реестра при импорте (top-level await, ESM) ----------
// Класс → представители; имя → классы. Обход fixtures/models/ один раз.
const ALL_NAMES = fs.readdirSync(FIXTURES_DIR).filter((f) => /\.(glb|gltf)$/i.test(f));
const NAME_SITUATIONS = new Map();
const CLASSIFICATION = new Map();
for (const name of ALL_NAMES) {
  const sit = await situationsOfFile(name);
  NAME_SITUATIONS.set(name, sit);
  for (const c of sit) {
    if (!CLASSIFICATION.has(c)) CLASSIFICATION.set(c, []);
    CLASSIFICATION.get(c).push(name);
  }
}

/** Все классы, к которым относится модель (массив строк-идентификаторов). */
export function situationsOf(modelName) {
  return NAME_SITUATIONS.get(modelName) || [];
}

/** Представители класса, присутствующие на диске (репо + локальные). */
export function modelsWith(classId) {
  return CLASSIFICATION.get(classId) || [];
}

/**
 * Итератор по классу в духе eachModel (tests/helpers/model-files.mjs). Если у класса
 * нет НИ ОДНОГО представителя на диске — graceful-пропуск с внятным именем
 * (видно в vitest-отчёте, класс не выпадает из корпуса молча).
 */
export function eachSituation(classId, prefix, body, timeout) {
  const reps = modelsWith(classId);
  if (!reps.length) {
    it.skip(`${prefix} [${classId}: представитель класса отсутствует на диске]`, () => {}, timeout);
    return;
  }
  for (const m of reps) it(`${m} — ${prefix}`, () => body(m), timeout);
}

// ---------- порядок классов + объявленные дыры корпуса (для мета-теста) ----------
export const SITUATION_IDS = [
  'no-geometry', 'no-textures', 'textures-only', 'skinned', 'morphed', 'animated',
  'shared-geometry', 'preinstanced', 'precompressed-draco', 'precompressed-meshopt',
  'prequantized', 'pre-webp', 'pre-ktx2', 'vertex-colors', 'multi-scene',
  'unknown-extension', 'broken', 'heavy', 'edge-name',
];

// Классы без представителя в корпусе — объявлены ЯВНО, с причиной. Мета-тест
// требует: либо у класса есть представитель (modelsWith), либо он объявлен здесь —
// и тогда представителей быть НЕ должно (объявление не имеет права устареть).
// ЗАКРЫТО 2026-08-04: четыре дыры — no-geometry, textures-only, multi-scene,
// pre-ktx2 — закрыты собственными моделями проекта (Empty Nodes 01, Texture Only 01,
// Two Scenes 01, Pre KTX2 01; генератор — _work/make-corpus-holes.mjs, лицензии
// Apache-2.0 рядом с моделями). Первый же прогон по ним нашёл два дефекта движка:
// чистка уносила ВСЕ узлы сцены без геометрии, а проверка габаритов объявляла такую
// модель разрушенной (сравнение с NaN у пустого bounding box). Оба закрыты.
//
// Это и есть цена необъявленной дыры: класс без представителя — не «нечего
// проверять», а «никто не проверял».
export const KNOWN_HOLES = {
  heavy: 'нет модели >50 МБ в fixtures/: тяжёлые модели живут в input/ (стресс — tests/heavy-stress-input.test.mjs) и у клиентов, в fixtures не добавляем',
};

/** Таблица «класс → представители на диске → сколько из них в git» — для отчёта. */
export function situationCoverage() {
  return SITUATION_IDS.map((id) => ({
    id,
    onDisk: modelsWith(id),
    inGit: modelsWith(id).filter((n) => REPO_MODELS.has(n)),
  }));
}

// Классы, покрытые ТОЛЬКО локальными моделями (у автора на диске; в git их нет —
// у сторонних моделей своя лицензия, fixtures/.gitignore их блокирует). Списки
// явные: на чистом клоне представителей этих классов на диске нет — это нормально,
// eachSituation их graceful-пропускает. Мета-тест сверяет объявленный список с
// фактическим, когда модели на диске есть.
export const LOCAL_ONLY = {
  skinned: ['RiggedSimple.glb', 'parkergirl.glb', 'Lilith Character 01.glb', 'chibi_zenitsu.glb', 'Cthulhu Stone 01.glb'],
  // `animated` УБРАН 2026-08-14 вслед за `unknown-extension`. Класс держался на чужих
  // моделях — персонажи и образцы Khronos, ни одна в git не едет. Значит любое
  // утверждение про анимацию проверялось только на машине Александра, а на чистом клоне
  // и на CI пропускалось молча. Теперь у класса есть свой представитель — Animated
  // Pointer 01, полтора килобайта, Apache-2.0.
  // `unknown-extension` отсюда УБРАН 2026-08-14. Класс был покрыт только образцами
  // Khronos, а они в git не едут — значит на чистом клоне и на CI обещание «мы не
  // ломаем такие модели» не проверял никто. Теперь у класса три своих представителя
  // (Unknown Ext LOD / Interactivity / Pointer 01), они коммитятся и работают везде.
  // Первый же прогон по ним нашёл дефект — TESTBUG-010 в tests/bugs-found.test.mjs.
};
