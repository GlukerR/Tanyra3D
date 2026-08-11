// addons/gltf/metrics.mts — измерения и снимки glTF-документа. Вынесено из optimize2.mjs
// без изменения логики; добавлен счётчик вершин (sum POSITION.count по всем примитивам
// сцены) — раньше его не было ни в метриках, ни в baseline-инварианте.
//
// Первый модуль АДДОНА на TypeScript (2026-08-11, после ядра). Выбран первым не по
// размеру: именно он задаёт форму метрик, которую движок до сих пор видел как
// «объект с какими-то ключами» (Metrics = Record<string, unknown> в core/types.mts).
// Теперь у неё есть имя и состав — GltfMetrics, — и ошибиться в ключе стало нельзя.
//
// Тип, а не интерфейс, у GltfMetrics и BaselineSnapshot намеренно: движок принимает
// Metrics = Record<string, unknown>, а интерфейс под индексную сигнатуру не подходит
// (у него нет индекса), тип-псевдоним — подходит. Разница только для компилятора.

import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';

import type { Document, Node, bbox } from '@gltf-transform/core';

/** Что мерим у модели. Состав задаёт аддон, движок только переносит это в отчёт. */
export type GltfMetrics = {
  fileBytes: number;
  drawCalls: number;
  triangles: number;
  vertices: number;
  morphTargets: number;
  /** Набор семантик строкой: «POSITION,NORMAL,TEXCOORD_0». Почему строкой — см. sceneGeometry. */
  attributes: string;
  textureBytes: number;
  gpuBytes: number;
  meshes: number;
  materials: number;
  textures: number;
  nodes: number;
  scenes: number;
  animations: number;
  skins: number;
  bounds: bbox | null;
};

/** Геометрия, посчитанная по сцене (а не по объектам-мешам). */
export type SceneGeometry = Pick<GltfMetrics, 'drawCalls' | 'triangles' | 'vertices' | 'morphTargets' | 'attributes'>;

/** Снимок структуры для baseline-checkpoint. Ключи перечислены в BASELINE_METRICS. */
export type BaselineSnapshot = {
  triangles: number;
  vertices: number;
  morphTargets: number;
  attributes: string;
  drawCalls: number;
  skins: number;
  nodes: number;
  animations: number;
};

// Треугольники, draw calls и ВЕРШИНЫ считаем ПО УЗЛАМ СЦЕНЫ, а не по объектам-мешам:
// dedup схлопывает одинаковые меши в «один меш на многих узлах», flatten разворачивает
// обратно — счёт по мешам прыгает, хотя рендер не меняется. Счёт по сцене инвариантен.
//
// GPU-инстансинг (EXT_mesh_gpu_instancing, fns.instance()) сворачивает N узлов, ссылавшихся
// на один меш, в ОДИН узел + расширение с N наборами трансформов — без поправки счёт
// треугольников/вершин упал бы в N раз (узел обходится один раз), хотя рисуется то же
// самое количество экземпляров. drawCalls НЕ умножаем — в этом и есть цель инстансинга
// (один draw call на батч, сколько бы экземпляров в нём ни было).
//
// Расширение описано структурно, а не типом из библиотеки: EXT_mesh_gpu_instancing живёт
// в отдельном пакете расширений, и тащить его сюда ради двух методов значило бы дать
// модулю измерений зависимость, которой у него не было. Проверки на наличие методов
// оставлены как были — сюда приходят и заглушки из тестов.
interface InstancingExtension {
  /** Необязательный: прежний код проверял его наличие, проверка сохранена. */
  listSemantics?: () => string[];
  /** Обязательный намеренно: прежний код звал его без проверки, и добавить её здесь
   *  значило бы завести в собранном коде ветку, которой в нём не было. */
  getAttribute: (semantic: string) => { getCount: () => number } | null;
}

function instanceCountOf(node: Node): number {
  const ext = (typeof node.getExtension === 'function'
    ? node.getExtension('EXT_mesh_gpu_instancing')
    : null) as InstancingExtension | null;
  if (!ext) return 1;
  const sem = ext.listSemantics && ext.listSemantics()[0];
  const attr = sem && ext.getAttribute(sem);
  return (attr && attr.getCount()) || 1;
}

export function sceneGeometry(doc: Document): SceneGeometry {
  let drawCalls = 0;
  let triangles = 0;
  let vertices = 0;
  // morph-таргеты и набор семантик — тоже по сцене, чтобы попасть в baseline-checkpoint
  // (GAP-005): их потеря не меняет ни треугольники, ни вершины, ни узлы, ни счётчик
  // анимаций — сверка шести старых ключей такую поломку не видела вовсе.
  let morphTargets = 0;
  const semantics = new Set<string>();
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const instances = instanceCountOf(node);
      for (const prim of mesh.listPrimitives()) {
        drawCalls += 1;
        // Число таргетов на примитив, БЕЗ умножения на экземпляры: инстансинг
        // повторяет геометрию, а не создаёт новые наборы деформации.
        morphTargets += prim.listTargets().length;
        for (const s of prim.listSemantics()) semantics.add(s);
        const pos = prim.getAttribute('POSITION');
        if (pos) vertices += pos.getCount() * instances;
        if (prim.getMode() === 4) {
          const idx = prim.getIndices();
          triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3) * instances;
        }
      }
    });
  }
  // Строка, а не число: «было POSITION,NORMAL,TEXCOORD_0 — стало POSITION,NORMAL»
  // читается в отчёте, счётчик «3 → 2» не сказал бы, какой канал потерян.
  return { drawCalls, triangles, vertices, morphTargets, attributes: [...semantics].sort().join(',') };
}

export function collectMetrics(doc: Document, fileBytes: number): GltfMetrics {
  const root = doc.getRoot();
  const { drawCalls, triangles, vertices, morphTargets, attributes } = sceneGeometry(doc);
  let textureBytes = 0;
  let gpuBytes = 0;
  try {
    const report = fns.inspect(doc);
    for (const t of report.textures.properties) {
      textureBytes += t.size || 0;
      gpuBytes += t.gpuSize || 0;
    }
  } catch {
    /* inspect может не поддержать экзотику — не критично */
  }
  return {
    fileBytes,
    drawCalls,
    triangles,
    vertices,
    morphTargets,
    attributes,
    textureBytes,
    gpuBytes,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    nodes: root.listNodes().length,
    scenes: root.listScenes().length,
    animations: root.listAnimations().length,
    skins: effectiveSkins(doc),
    bounds: sceneBounds(doc),
  };
}

// «Действующие» скины: привязаны к узлу, чей меш реально имеет JOINTS_0 (без него
// скин ничего не деформирует). Экспортёры оставляют скины-пустышки при node-анимации —
// их удаление рендер не меняет, и инвариант не должен считать это потерей.
export function effectiveSkins(doc: Document): number {
  const used = new Set<unknown>();
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (mesh.listPrimitives().some((p) => p.getAttribute('JOINTS_0'))) used.add(skin);
  }
  return used.size;
}

export function sceneBounds(doc: Document): bbox | null {
  // bounding box сцены — для инварианта «модель не съехала и не схлопнулась»
  if (typeof gltfCore.getBounds !== 'function') return null;
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;
  try { return gltfCore.getBounds(scene); } catch { return null; }
}

export function countTriangles(doc: Document): number {
  return sceneGeometry(doc).triangles;
}

// ---------- baseline-checkpoint (двухуровневая обработка) ----------
// Метрики-инварианты СТРУКТУРЫ модели. Снимок делается после базовых оптимизаций
// (tier basic) и сверяется после расширений (tier advanced): расширения — только
// сжатие/кодирование, эти значения меняться НЕ должны. Любое будущее расширение
// (Draco, KTX2, decimation, ...) валидируется этой сверкой автоматически, без
// специальных проверок под каждое. VRAM/textureBytes/fileBytes сюда НЕ входят —
// им меняться можно (в этом смысл сжатия).
//
// ОФИЦИАЛЬНЫЕ ГАРАНТИИ КОМПОНЕНТОВ (docs/ЗАВИСИМОСТИ.md):
//   - Draco (google/draco 1.5.7): НЕ меняет количество треугольников и топологию
//     mesh; квантизация трогает только точность позиций/нормалей.
//   - Meshopt (zeux/meshoptimizer через EXT_meshopt_compression): НЕ меняет
//     топологию, кодирование полностью обратимо.
//   - KTX2 (@gltf-transform/extensions + toktx): кодирует ТОЛЬКО текстуры,
//     геометрия/сцена/анимации неизменны.
//   - strip-colors и прочие атрибутные операции: не трогают baseline-метрики.
// Следствие: расхождение baseline после второго прохода — ВСЕГДА ошибка
// (неправильное применение компонента, баг в библиотеке или недочищенный вход),
// а не «допустимая погрешность». Поэтому сверка STRICT, без допусков.
// GAP-005: к шести исходным ключам добавлены morphTargets и attributes. Потеря
// morph-таргета или UV/COLOR-канала во втором проходе не меняла ни один из шести —
// файл записывался, а отчёт говорил «все проверки пройдены». Пример из корпуса:
// parkergirl несёт 456 morph-таргетов на восьми примитивах при skins=1; повреждение
// такой модели ловится только этими двумя ключами.
//
// Список читается ещё и как ТЕКСТ — tests/gap-005-regression.test.mjs разбирает его
// регулярным выражением, не импортируя модуль. Поэтому запись остаётся однострочным
// литералом, и поэтому же здесь НЕТ аннотации типа: `string[]` компилятор выводит сам,
// а в тексте она встала бы между именем и `=` и сломала бы разбор. То же у BASELINE_SOFT.
export const BASELINE_METRICS = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations', 'morphTargets', 'attributes'];

// Мягкие ключи checkpoint: их расхождение информирует, но НЕ блокирует запись (см.
// compareBaseline в core/contract.mjs). vertices — кодек (Draco) сваривает вершины при
// сериализации; число вершин меняется, топология/треугольники — нет.
// `nodes` стал мягким вместе с переносом geometry/compress во второй проход. Meshopt
// работает через KHR_mesh_quantization: квантование запекает масштаб/смещение, и
// gltf-transform добавляет узлы-обёртки, чтобы нести эту трансформацию. На CarConcept
// это 101 → 107 узлов при неизменных треугольниках, draw calls и картинке. Официальная
// гарантия компонентов (§0a) говорит про топологию меша, а не про число узлов сцены, —
// держать `nodes` жёстким значило бы блокировать запись на законном поведении кодека.
// Структуру продолжают защищать triangles/drawCalls/skins/animations/morphTargets/attributes.
export const BASELINE_SOFT = new Set(['vertices', 'nodes']);

export function baselineSnapshot(doc: Document): BaselineSnapshot {
  const { drawCalls, triangles, vertices, morphTargets, attributes } = sceneGeometry(doc);
  return {
    triangles,
    vertices,
    morphTargets,
    attributes,
    drawCalls,
    skins: effectiveSkins(doc),
    nodes: doc.getRoot().listNodes().length,
    animations: doc.getRoot().listAnimations().length,
  };
}

export function listSemantics(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  return out;
}

export const MB = (b: number): string => (b / (1024 * 1024)).toFixed(2);
