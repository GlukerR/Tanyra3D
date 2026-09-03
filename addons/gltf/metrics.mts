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
  /**
   * Вершины, которые РИСУЮТСЯ: счёт по узлам сцены, с учётом переиспользования одного
   * меша многими узлами и с умножением на экземпляры инстансинга.
   */
  vertices: number;
  /**
   * Вершины, которые ХРАНЯТСЯ: сумма по уникальным буферам позиций, без повторов.
   *
   * Две величины вместо одной — решение 2026-07-31. Пока число было
   * одно, оно молча прятало ровно тот случай, ради которого на него смотрят: когда
   * `join` разворачивает общую геометрию в копии, рисуемых остаётся столько же, а
   * хранимых становится втрое больше. Файл и видеопамять растут, а метрика неподвижна.
   *
   * В baseline-снимок эта величина НЕ входит намеренно: там сверяется то, что меняться
   * не должно, а хранимым как раз положено меняться — в этом смысл объединения мешей.
   */
  verticesStored: number;
  morphTargets: number;
  /** Набор семантик строкой: «POSITION,NORMAL,TEXCOORD_0». Почему строкой — см. sceneGeometry. */
  attributes: string;
  textureBytes: number;
  gpuBytes: number;
  /**
   * Наибольшая сторона самой крупной текстуры, в пикселях. 0 — текстур нет либо ни у
   * одной не удалось прочитать размер.
   *
   * Заведено 2026-08-12. До этого размерности не было вовсе, и порог `textureMaxSize`
   * во ВСЕХ профилях был декоративным: число человеку показывали, сверить его было не с
   * чем (записано в `profiles/_none.json`, README и `ЧТО_УМЕЕТ.md` как известная дыра).
   *
   * Именно наибольшая сторона, а не площадь и не пара чисел: пороги площадок заданы
   * стороной («textures width/height maximum 2048» у Khronos 3D Commerce), и сравнивать
   * надо в тех же единицах, в которых написан порог.
   */
  textureMaxSize: number;
  /**
   * Частей, у которых ЕСТЬ развёртка и НЕТ ни одной карты.
   *
   * Зачем считается. Безопасная чистка убирает развёртку, которой не пользуется ни один
   * материал, — и это верно ровно до одного случая: модели для конфигуратора, где
   * покрытие назначают уже на сайте. Александр, 2026-08-29: «там могут быть уже готовы
   * юви, но не быть прикрепленной никакой текстуры… модель нужна нам для конфигуратора
   * на сайте где клиент может выбирать кучи разных вариантов покрытия».
   *
   * По этому числу интерфейс решает, показывать ли подчинённую строку «оставить
   * развёртку». Ноль — показывать нечего: сохранять нечего, и клавиша была бы пустой
   * (Правило 12).
   *
   * Признак НАРОЧНО узкий: материала без единой карты достаточно, чтобы утверждать
   * «эту развёртку сейчас не читает никто». Обратное — «у материала карты есть, но
   * второй канал развёртки не читает ни одна» — сюда не входит: такой канал наплодил
   * экспортёр, и сохранять его человек не просит.
   */
  uvWithoutTextures: number;
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

/**
 * Наибольшая сторона среди всех текстур документа.
 *
 * Размер берётся у САМОГО файла картинки — `ImageUtils.getSize()` читает заголовок
 * (PNG, JPEG, WebP, KTX2 — у каждого свой), а не декодирует изображение. Декодировать
 * сотню текстур по 4K значило бы минуты работы и гигабайты памяти ради двух чисел.
 *
 * Текстура, размер которой прочитать не удалось (экзотический формат, обрезанный файл),
 * молча пропускается: соврать числом хуже, чем не показать его. Полное отсутствие
 * размеров даёт 0 — и тогда сверка с порогом просто не выносится.
 */
function maxTextureSide(doc: Document): number {
  let max = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const size = textureSize(tex.getImage(), tex.getMimeType());
    if (!size) continue;
    max = Math.max(max, size[0] || 0, size[1] || 0);
  }
  return max;
}

/**
 * Вершины, которые лежат в файле, — по УНИКАЛЬНЫМ буферам позиций.
 *
 * Ключ дедупликации — сам аксессор: меш, на который ссылаются десять узлов, хранится
 * один раз, и десять раз его считать нельзя. Обход идёт по мешам документа, а не по
 * сцене: вершины занимают место в файле независимо от того, попал ли меш в сцену.
 */
function storedVertices(doc: Document): number {
  const seen = new Set<object>();
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || seen.has(pos)) continue;
      seen.add(pos);
      total += pos.getCount();
    }
  }
  return total;
}

/**
 * Ширина и высота картинки, либо null — прочитать не удалось (формат без читателя
 * размеров, обрезанный файл, заглушка вместо картинки).
 *
 * ЕДИНСТВЕННОЕ место в проекте, где читается размер текстуры: отсюда его берут и
 * метрики, и правило `textures/resize`. Разойдись эти два чтения — правило уменьшало бы
 * одно, а отчёт показывал бы другое.
 */
export function textureSize(image: Uint8Array | null, mime: string | null): number[] | null {
  if (!image || !mime) return null;
  try {
    return gltfCore.ImageUtils.getSize(image, mime);
  } catch {
    return null;
  }
}

/**
 * Частей с развёрткой, у которых материал не несёт ни одной карты.
 *
 * Считается по примитивам, а не по мешам: материал живёт на примитиве, и у меша из двух
 * частей одна может быть с картой, другая без.
 *
 * Примитив БЕЗ материала тоже считается: материала нет — карт нет, читать развёртку
 * нечем.
 */
function uvWithoutTextures(doc: Document): number {
  // Материалы, у которых есть хоть одна карта. Считаем ОТ ТЕКСТУР, а не перебором слотов
  // материала: слоты приносят и расширения (лист, ткань, прозрачность), и список пришлось
  // бы держать вторым, расходящимся с библиотекой. Ссылка же одна, и она видна с той
  // стороны — texture.listParents().
  const сКартами = new Set<unknown>();
  for (const tex of doc.getRoot().listTextures()) {
    for (const parent of tex.listParents()) сКартами.add(parent);
  }

  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (!prim.listSemantics().some((s) => s.startsWith('TEXCOORD_'))) continue;
      const material = prim.getMaterial();
      if (!material || !сКартами.has(material)) n += 1;
    }
  }
  return n;
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
    textureMaxSize: maxTextureSide(doc),
    uvWithoutTextures: uvWithoutTextures(doc),
    verticesStored: storedVertices(doc),
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

function sceneBounds(doc: Document): bbox | null {
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
//   - Draco (google/draco 1.5.7): квантизация трогает только точность позиций/нормалей,
//     топологию mesh не меняет. НО кодировщик выбрасывает треугольники НУЛЕВОЙ ПЛОЩАДИ —
//     те, у которых два угла стоят в одной точке. Замер 2026-08-22 по 61 модели: потеря
//     совпадала с их числом до единицы и от числа бит квантования не зависела вовсе.
//     Поэтому такие треугольники убирает geometry/degenerate-triangles в БАЗОВОМ проходе,
//     до снимка: кодировщику тогда терять нечего, и сверка сходится (см. docs/ЗАВИСИМОСТИ.md
//     и tests/degenerate-triangles.test.mjs).
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
// гарантия компонентов (docs/ЗАВИСИМОСТИ.md) говорит про топологию меша, а не про число узлов сцены, —
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
