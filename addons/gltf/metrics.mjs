// addons/gltf/metrics.mjs — измерения и снимки glTF-документа. Вынесено из optimize2.mjs
// без изменения логики; добавлен счётчик вершин (sum POSITION.count по всем примитивам
// сцены) — раньше его не было ни в метриках, ни в baseline-инварианте.

import * as gltfCore from '@gltf-transform/core';
import * as fns from '@gltf-transform/functions';

// Треугольники, draw calls и ВЕРШИНЫ считаем ПО УЗЛАМ СЦЕНЫ, а не по объектам-мешам:
// dedup схлопывает одинаковые меши в «один меш на многих узлах», flatten разворачивает
// обратно — счёт по мешам прыгает, хотя рендер не меняется. Счёт по сцене инвариантен.
//
// GPU-инстансинг (EXT_mesh_gpu_instancing, fns.instance()) сворачивает N узлов, ссылавшихся
// на один меш, в ОДИН узел + расширение с N наборами трансформов — без поправки счёт
// треугольников/вершин упал бы в N раз (узел обходится один раз), хотя рисуется то же
// самое количество экземпляров. drawCalls НЕ умножаем — в этом и есть цель инстансинга
// (один draw call на батч, сколько бы экземпляров в нём ни было).
function instanceCountOf(node) {
  const ext = typeof node.getExtension === 'function' ? node.getExtension('EXT_mesh_gpu_instancing') : null;
  if (!ext) return 1;
  const sem = ext.listSemantics && ext.listSemantics()[0];
  const attr = sem && ext.getAttribute(sem);
  return (attr && attr.getCount()) || 1;
}

export function sceneGeometry(doc) {
  let drawCalls = 0;
  let triangles = 0;
  let vertices = 0;
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const instances = instanceCountOf(node);
      for (const prim of mesh.listPrimitives()) {
        drawCalls += 1;
        const pos = prim.getAttribute('POSITION');
        if (pos) vertices += pos.getCount() * instances;
        if (prim.getMode() === 4) {
          const idx = prim.getIndices();
          triangles += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3) * instances;
        }
      }
    });
  }
  return { drawCalls, triangles, vertices };
}

export function collectMetrics(doc, fileBytes) {
  const root = doc.getRoot();
  const { drawCalls, triangles, vertices } = sceneGeometry(doc);
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
export function effectiveSkins(doc) {
  const used = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    if (mesh.listPrimitives().some((p) => p.getAttribute('JOINTS_0'))) used.add(skin);
  }
  return used.size;
}

export function sceneBounds(doc) {
  // bounding box сцены — для инварианта «модель не съехала и не схлопнулась»
  if (typeof gltfCore.getBounds !== 'function') return null;
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  if (!scene) return null;
  try { return gltfCore.getBounds(scene); } catch { return null; }
}

export function countTriangles(doc) {
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
export const BASELINE_METRICS = ['triangles', 'vertices', 'drawCalls', 'skins', 'nodes', 'animations'];

// Мягкие ключи checkpoint: их расхождение информирует, но НЕ блокирует запись (см.
// compareBaseline в core/engine.mjs). vertices — кодек (Draco) сваривает вершины при
// сериализации; число вершин меняется, топология/треугольники — нет.
export const BASELINE_SOFT = new Set(['vertices']);

export function baselineSnapshot(doc) {
  const { drawCalls, triangles, vertices } = sceneGeometry(doc);
  return {
    triangles,
    vertices,
    drawCalls,
    skins: effectiveSkins(doc),
    nodes: doc.getRoot().listNodes().length,
    animations: doc.getRoot().listAnimations().length,
  };
}

export function listSemantics(doc) {
  const out = new Set();
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) out.add(s);
  return out;
}

export const MB = (b) => (b / (1024 * 1024)).toFixed(2);
