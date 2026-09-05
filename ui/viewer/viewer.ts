// viewer.ts — встроенный 3D-просмотрщик одной GLB-модели (движок Three.js).
// Портирован из просмотрщика D:\others\threejsview (класс Viewer, Three.js r185) и
// адаптирован под ПРОИЗВОЛЬНЫЕ модели: авто-кадрирование по bounding box вместо
// хардкод-камеры + KTX2Loader (оптимизированные файлы бывают сжаты в KTX2, чего в
// исходном просмотрщике не было) + корректная выгрузка/перезагрузка модели.
//
// Это конкретная РЕАЛИЗАЦИЯ движка просмотра за узким интерфейсом (см. createViewer в
// index.ts) — по аналогии с core/addon в ядре: обвязка двух вьюпортов не знает про
// Three.js, а будущий движок/режим (дизайнерский режим, показ пропавших точек, свой
// свет) подключается через тот же интерфейс, не переписывая dual-viewport.js.

import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFAnimationPointerExtension } from "@needle-tools/three-animation-pointer";
import GLTFMaterialsVariantsExtension from "three-gltf-extensions/loaders/KHR_materials_variants/KHR_materials_variants.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
// Контракт движка просмотра. Импорт типов, а не кода: в собранный файл он не попадает.
import type { CameraState, DisplayMode, LoadOptions, ViewerLike } from "./contract.js";
import { DISPLAY_MODES } from "./contract.js";
import { buildUvPointerDriver, stripUvTransformTracks, type UvPointerDriver } from "./pointer-uv.js";
import { detectLods, showLod, type LodSet } from "./lod.js";
import { applyNodeVisibility, findInteractive, InteractivityHighlight, type InteractivePart } from "./interactivity.js";
import { InteractivityRuntime } from "./interactivity-runtime.js";
import { GLTFDiffuseTransmissionExtension } from "./diffuse-transmission.js";

// Пути к декодерам — тоже из node_modules/three через /vendor-роут сервера (server.mjs).
const DRACO_DECODER_PATH = "/vendor/three/examples/jsm/libs/draco/gltf/";
const KTX2_TRANSCODER_PATH = "/vendor/three/examples/jsm/libs/basis/";

/** Форматы, которые открывает не glTF-загрузчик, а свой. См. Viewer._loadForeign. */
const FOREIGN_FORMATS = ["stl", "ply", "fbx", "obj"];

/**
 * Узел при обходе сцены. Обход отдаёт узлы ЛЮБОГО вида — свет, кости, пустышки, —
 * а геометрия и материал есть только у мешей. Отсюда «меш, у которого всё
 * необязательно»: проверки на наличие поля в коде ниже остаются ровно теми, какими
 * были, и ни одного приведения типа в теле обхода не появляется.
 */
type MaybeMesh = THREE.Object3D & {
  isMesh?: boolean | undefined;
  geometry?: THREE.BufferGeometry | undefined;
  material?: THREE.Material | THREE.Material[] | undefined;
};

/**
 * Разобранный JSON модели — ровно те поля, которые читают проверки ниже.
 *
 * Полной схемы glTF здесь нет намеренно: это не разбор формата, а два вопроса к
 * готовому файлу («что уже сжато» и «что напрашивается»). Описывать ради них весь
 * стандарт значило бы завести вторую копию спецификации, которая начнёт расходиться
 * с настоящей при первом же расширении.
 */
interface GltfJson {
  extensionsUsed?: string[];
  images?: Array<{ mimeType?: string }>;
  nodes?: Array<{ mesh?: number }>;
}

// CameraState и LoadOptions переехали в contract.ts и берутся оттуда: это ДАННЫЕ обмена
// между вьюпортами, а не устройство три.js. Здесь они реэкспортируются, чтобы уже
// написанные импорты из viewer.js продолжали работать.
export type { CameraState, LoadOptions } from "./contract.js";

/**
 * Освободить память под поддеревом: геометрии, материалы и все их текстуры.
 * Отдельной функцией, потому что освобождать приходится два разных дерева — модель,
 * которая была в сцене, и модель устаревшей загрузки, которая до сцены не дошла.
 * Из сцены объект снимает вызывающий: у второго случая сцены и нет.
 */
function disposeSubtree(root: THREE.Object3D | null) {
  if (!root) return;
  root.traverse((obj: MaybeMesh) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        for (const key of Object.keys(mat)) {
          const val = (mat as unknown as Record<string, unknown>)[key] as THREE.Texture | undefined;
          if (val && val.isTexture) val.dispose();
        }
        mat.dispose();
      }
    }
  });
}

/**
 * Матовая «глина» для показа моделей без текстур — рисуется КОДОМ, файлом не возится.
 *
 * Зачем вообще. Модель без единой текстуры приезжает с белым материалом по умолчанию, и
 * белое под ровным светом читается как силуэт без формы: рёбра, углубления и толщина
 * детали пропадают. Александр 2026-08-20: «нам нужно сделать какой-то материал который
 * очень хорошо будет виден на полностью безтекстурных пустых моделях. Потому что просто
 * белая модель это не хорошо».
 *
 * Почему matcap, а не «настроить свет получше». Matcap — картинка шара, освещённого один
 * раз навсегда; цвет точки берётся по НАПРАВЛЕНИЮ нормали, а не по расчёту от источников.
 * Отсюда три свойства, каждое из которых здесь важнее физической правды:
 *   - форма читается везде одинаково, включая то, что отвернулось от источника;
 *   - картинка не зависит ни от света модели, ни от экспозиции — значит левое и правое
 *     окно сравниваются честно, различие в них может быть только от самой геометрии;
 *   - считается это дешевле обычного материала, а модели тут бывают на два миллиона
 *     треугольников.
 *
 * Почему рисуем сами, а не кладём готовый PNG: приложение работает без интернета и не
 * должно тащить лишних файлов, а нужный нам шар — это три градиента.
 *
 * Тёплый серый, а не белый и не цветной: белое снова слепит, а цвет читался бы как
 * свойство модели («у меня деталь синяя?»). Серый глиняный — общепринятый язык
 * трёхмерных редакторов, и человек понимает его без объяснений.
 */
function makeClayMatcap() {
  const SIZE = 256;
  const R = SIZE / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

  // Шар занимает ВПИСАННУЮ окружность: цвет берётся по адресу `нормаль.xy * 0.5 + 0.5`,
  // и дальше половины картинки обращений не бывает. Значит и свет, и тень обязаны
  // уложиться внутрь этого круга. Первая редакция об этом забыла — тёмные остановки
  // градиента оказались за краем, и шар вышел ровно-светлым: та самая плоская белизна,
  // от которой всё и затевалось.
  const lx = SIZE * 0.34;
  const ly = SIZE * 0.30;
  const body = ctx.createRadialGradient(lx, ly, SIZE * 0.02, lx, ly, SIZE * 0.80);
  body.addColorStop(0.00, "#fffdf7");
  body.addColorStop(0.13, "#f6f0e4");
  body.addColorStop(0.30, "#ddd3c2");
  body.addColorStop(0.38, "#b3a897");
  body.addColorStop(0.52, "#9a8f80");
  body.addColorStop(0.62, "#6e6459");
  body.addColorStop(0.80, "#4a443d");
  body.addColorStop(1.00, "#2b2926");
  ctx.fillStyle = body;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Световая полоса поперёк — как отражение софтбокса в студии, и здесь она рабочий
  // инструмент, а не украшение. Александр 2026-08-20: «глину нужно сделать максимально
  // понятной, чтобы даже плоские объекты были видны на ней».
  //
  // Беда плоских деталей вот в чём: цвет берётся ТОЛЬКО по направлению поверхности, и две
  // грани, повёрнутые почти одинаково, получают почти одинаковый тон — ребро между ними
  // исчезает. Полоса и сближенные остановки градиента выше создают резкие ступени тона:
  // грань, отклонённая на пять градусов, пересекает ступень и заметно меняет яркость.
  //
  // Замерено на самой картинке: наклон в 5° давал разброс яркости 19 из 255, стал 37;
  // наклон в 10° — было 38, стало 65. Сторож этих чисел — в tests/import-formats.
  const band = ctx.createLinearGradient(0, SIZE * 0.12, 0, SIZE * 0.52);
  band.addColorStop(0.00, "rgba(255,255,255,0)");
  band.addColorStop(0.42, "rgba(255,255,255,0.26)");
  band.addColorStop(0.58, "rgba(255,255,255,0.26)");
  band.addColorStop(1.00, "rgba(255,255,255,0)");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Холодный отсвет снизу-справа — как от пола в студии. Слабый и МАЛЕНЬКИЙ: во второй
  // редакции он был вдвое шире и ярче и съедал собственную тень, оставляя тот же плоский
  // шар. Холодный он не для красоты — тёплый свет и холодная тень разводят стороны
  // детали лучше, чем разница в яркости.
  const bx = SIZE * 0.72;
  const by = SIZE * 0.80;
  const bounce = ctx.createRadialGradient(bx, by, SIZE * 0.01, bx, by, SIZE * 0.32);
  bounce.addColorStop(0, "rgba(120,144,180,0.50)");
  bounce.addColorStop(1, "rgba(126,146,178,0)");
  ctx.fillStyle = bounce;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Ободок по самому краю — то, ради чего это всё: он обводит силуэт и отделяет деталь
  // от соседней, когда обе одного цвета и стоят вплотную.
  //
  // По кругу НЕ обрезаем намеренно. За краем градиент растягивается последним цветом, и
  // углы выходят светлыми; обрежь — там осталась бы чернота, а на скользящих углах
  // сглаживание подмешивает соседний пиксель прямо в кромку детали. Светлая примесь на
  // кромке продолжает ободок, тёмная выглядела бы грязью.
  const rim = ctx.createRadialGradient(R, R, R * 0.88, R, R, R);
  rim.addColorStop(0, "rgba(255,252,245,0)");
  rim.addColorStop(0.50, "rgba(255,252,245,0.34)");
  rim.addColorStop(1, "rgba(255,252,245,0.92)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Базовые метрики модели из загруженной сцены (клиентская прикидка до оптимизации):
 * треугольники, вершины, число мешей (draw calls), уникальные материалы/текстуры.
 * После сборки эти цифры заменяются авторитетными метриками ядра (before/after).
 */
function computeSceneStats(root: THREE.Object3D) {
  let triangles = 0;
  let vertices = 0;
  let drawCalls = 0;
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((o: MaybeMesh) => {
    if (!o.isMesh || !o.geometry) return;
    drawCalls++;
    const pos = o.geometry.attributes.position;
    if (pos) vertices += pos.count;
    triangles += (o.geometry.index ? o.geometry.index.count : pos ? pos.count : 0) / 3;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      materials.add(m);
      for (const key of Object.keys(m)) {
        const val = (m as unknown as Record<string, unknown>)[key] as THREE.Texture | undefined;
        if (val && val.isTexture) textures.add(val);
      }
    }
  });

  return {
    triangles: Math.round(triangles),
    vertices,
    drawCalls,
    materials: materials.size,
    textures: textures.size,
  };
}

// Что уже применено в исходной модели — по extensionsUsed из распарсенного glTF.
// Draco/meshopt (геометрия), KHR_texture_basisu = KTX2 (текстуры).
// KTX2 дополнительно проверяем и по mimeType картинок: некоторые экспортёры кладут
// image/ktx2, не объявляя KHR_texture_basisu корректно (та же "слепота" валидатора,
// что разбирается в addons/gltf/index.mjs) — без этой проверки такие модели не помечались
// бы как источник KTX2, хотя KTX2 в них фактически есть.
function detectSource(gltf: GLTF) {
  const json: GltfJson = (gltf && gltf.parser && gltf.parser.json) || {};
  const used = json.extensionsUsed || [];
  const images = json.images || [];
  const hasKtx2Mime = images.some((img: { mimeType?: string }) => img.mimeType === 'image/ktx2');
  return {
    draco: used.includes('KHR_draco_mesh_compression'),
    meshopt: used.includes('EXT_meshopt_compression'),
    ktx2: used.includes('KHR_texture_basisu') || hasKtx2Mime,
    instance: used.includes('EXT_mesh_gpu_instancing'),
    // Не «что уже сделано», а «что напрашивается» — см. detectOpportunity.
    opportunity: detectOpportunity(json),
  };
}

// Возможности, которые видно по содержимому модели. Это ДРУГОЕ, чем detectSource:
// там «в файле уже есть, мы сохраняем», здесь «в файле этого нет, но стоит включить».
// Смешивать нельзя — иначе значок [Source] перестанет что-либо означать.
//
// Пока одна возможность: общая геометрия. Несколько узлов ссылаются на один меш —
// это Alt+D из Blender (связанные дубликаты) или результат дедупликации. Такая модель
// выигрывает от GPU-инстансинга и ПРОИГРЫВАЕТ от объединения мешей: join обязан
// запечь трансформ каждого узла в вершины, то есть размножить общую геометрию в копии.
// Замерено на ABeautifulGame: join в одиночку +84 %, он же после instance — 0 %.
function detectOpportunity(json: GltfJson) {
  const nodes = json.nodes || [];
  const users = new Map<number, number>();
  for (const n of nodes) {
    if (n.mesh == null) continue;
    users.set(n.mesh, (users.get(n.mesh) || 0) + 1);
  }
  let sharedMeshes = 0;
  let sharedNodes = 0;
  for (const count of users.values()) {
    if (count < 2) continue;
    sharedMeshes++;
    sharedNodes += count;
  }
  return { sharedMeshes, sharedNodes };
}

/**
 * Сторож ОСИРОТЕВШИХ каналов анимации — плагин к загрузчику, свой, восемь строк.
 *
 * Осиротевший канал — это `"path": "pointer"` БЕЗ блока `KHR_animation_pointer` рядом.
 * Такой канал не адресует ничего: ни узла сцены (у указателей его не бывает), ни места
 * в документе (адрес лежал как раз в снятом расширении). Валидатор Khronos отвечает на
 * него `VALUE_NOT_IN_LIST` — файл невалиден.
 *
 * Откуда он берётся. Это наш собственный след: под оптимизациями библиотека снимает
 * незнакомое ей расширение, а слово `pointer` в поле `path` остаётся. Дефект известен и
 * пока не закрыт — решение по нему за Александром.
 *
 * Почему без сторожа модель НЕ ОТКРЫВАЕТСЯ ВООБЩЕ. Обычный загрузчик three.js такой
 * канал пропускает (`if (target.node === undefined) continue`). Плагин указателя —
 * форк того же метода, и он поступает иначе: не узнав своего расширения, отдаёт канал
 * обычной ветке, а та просит узел с номером `undefined`. Запрос отклоняется, и вместе с
 * ним рушится загрузка всей модели. То есть плагин превращал «анимации не видно» в
 * «модель не показывается» — на файлах, которые испортили мы сами.
 *
 * Что делает сторож: снимает такие каналы до разбора. Ничего не скрывает — правый
 * вьюпорт всё равно останется без анимации, и рядом с живым левым это видно сразу.
 * Разница в том, что смотреть будет на что.
 */
function orphanPointerGuard(parser: { json: { animations?: Array<{ channels?: Array<{ target?: { path?: string; extensions?: Record<string, unknown> } }> }> } }) {
  return {
    name: 'TANYRA_orphan_pointer_guard',
    beforeRoot() {
      let dropped = 0;
      for (const anim of parser.json.animations || []) {
        if (!anim.channels) continue;
        const kept = anim.channels.filter((ch) => {
          const t = ch.target;
          const orphan = t && t.path === 'pointer' && !(t.extensions && t.extensions['KHR_animation_pointer']);
          if (orphan) dropped++;
          return !orphan;
        });
        anim.channels = kept;
      }
      if (dropped) {
        console.warn(`Анимация: снято осиротевших каналов по указателю — ${dropped}. `
          + 'В файле осталось слово "pointer" без адреса: расширение KHR_animation_pointer снято, а канал нет. '
          + 'Модель показана без этой анимации.');
      }
      return null;
    },
  };
}

/**
 * Сколько остаётся от окружения в режиме «свет из файла». Не ноль намеренно — почему,
 * подробно у setLightMode(): окружение это не свет, а то, что отражается, и его
 * обнуление красит металл и стекло в чёрный, а не показывает замысел автора.
 */
const FILE_MODE_ENV = 0.15;

/**
 * Камера из файла. glTF знает два вида, и оба настоящие: перспективную выбирают для
 * обычного взгляда, ортографическую — когда схождение линий мешает (чертёж, изометрия,
 * вид сбоку). Держим оба типа в одном списке; различаются они только тем, как задаётся
 * ширина кадра (см. _applyAspect).
 */
type FileCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/**
 * Чем показывать модель. Порядок — блендеровский, слева направо по нарастанию
 * достоверности: сетка → глина → материалы из файла (Александр, 2026-08-27).
 *
 * Умолчание — 'file', и оно ставится при КАЖДОЙ новой модели (`_resetDisplayMaterial`).
 * Модель без материалов показывается белой сразу; глина и сетка — только по личному
 * выбору человека.
 */
// Список и тип — из `contract.ts`: это часть контракта движка, а не свойство ЭТОГО
// движка. Здесь их держать нельзя, иначе второй движок завёл бы свой (ревизия 2026-09-01).
export type { DisplayMode } from "./contract.js";

/**
 * Самодостаточный просмотрщик одной модели: рендерер, сцена, студийный IBL-свет,
 * орбитальные контролы, авто-кадрирование под размер модели.
 */
/**
 * Набор карт одного материала: то, что сравнивается в режиме различий. Пустые слоты
 * законны — у материала может не быть ни нормалей, ни свечения.
 */
type SlotMaps = Partial<Record<(typeof Viewer.DIFF_SLOTS)[number], THREE.Texture | null>>;

/**
 * Эталон одного МАТЕРИАЛА: его имя и его карты.
 *
 * КЛЮЧ СОПОСТАВЛЕНИЯ — МАТЕРИАЛ, а не деталь и не текстура. Через это прошли три
 * редакции, и каждая следующая появилась из замера.
 *
 *   ПО МЕСТУ В ОБХОДЕ — неверно. Сборка ПЕРЕСТАВЛЯЕТ детали: на `ABeautifulGame` их
 *   поровну, 49 и 49, но под номером 6 слева `Pawn_Top_W1`, справа уже `Pawn_Body_W2` —
 *   43 расхождения из 49 (`_work/pairs.mjs`). Верх пешки сравнивался с телом соседней;
 *   Александр 2026-09-03: «будто пешек не 2 вида, а 4».
 *
 *   ПО ТЕКСТУРЕ — не за что ухватиться. В четырёх моделях из пяти текстуры БЕЗЫМЯННЫ
 *   (`_work/mat-pairs.mjs`), и единственным ключом остаётся порядок — ровно то, что
 *   сборка и ломает.
 *
 *   ПО ДЕТАЛИ — работает, но хуже: деталей больше, и часть из них сборка склеивает. На
 *   `Production Multi UV 01` деталей нашлось 14 из 17, а материалов — все 17.
 *
 * Материал выигрывает по всем замерам сразу: их меньше (15 против 49 на шахматах), имена
 * совпадают во всех пяти проверенных моделях, и склейка деталей их не задевает — join
 * сливает детали ВНУТРИ материала. Вопрос «что стало с текстурами» и задан про материал:
 * карты живут у него, а не у детали.
 *
 * Мысль убрать лишнее звено — Александра, 2026-09-04: «тебе ничего самому сопоставлять не
 * нужно, UV-текстура сама сопоставит всё».
 */
type DiffRef = { имя: string; карты: SlotMaps };

/**
 * Сырое отклонение пары карт: байт на пиксель, плюс два итога по ней.
 *
 * `среднее` — им и меряется, насколько пострадала ДЕТАЛЬ; `max` — самый выбившийся пиксель,
 * он оставлен для сведений и шкалу не задаёт. Почему не задаёт — см. `_diffColor`.
 */
type DiffRaw = {
  data: Uint8Array; w: number; h: number; max: number; среднее: number;
  /** Средняя схожесть структуры по карте: 1 — структура цела, 0 — не осталось ничего. */
  ssim: number;
  flipY: boolean;
};

export class Viewer implements ViewerLike {
  // Только объявления: `declare` проверяется компилятором и не попадает в собранный
  // файл — значения по-прежнему присваивают конструктор и методы _init*().
  declare canvas: HTMLCanvasElement;
  declare model: THREE.Object3D | null;
  declare _loadToken: number;
  declare renderer: THREE.WebGLRenderer;
  /** Снятые пиксели на время одного расчёта: одна текстура читается с видеокарты раз. */
  declare _пиксели?: Map<string, Uint8ClampedArray>;
  /** Однажды собранная оснастка для съёма пикселей с видеокарты. См. `_пикселиТекстуры`. */
  declare _съёмник?: {
    scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.MeshBasicMaterial;
    rt: THREE.WebGLRenderTarget | null; w: number; h: number;
  };
  declare scene: THREE.Scene;
  declare camera: THREE.PerspectiveCamera;
  declare controls: OrbitControls;
  declare _resizeObserver: ResizeObserver;
  declare _draco: DRACOLoader;
  declare _ktx2: KTX2Loader;
  declare _loader: GLTFLoader;
  declare _manager: THREE.LoadingManager;
  /** Геометрии, которым нормали досчитала ГЛИНА. Снимаются при выходе из неё. */
  declare _clayNormals?: Set<THREE.BufferGeometry>;
  /** Материал показа: 'file' — как в файле, 'clay' — глина, 'wire' — сетка. См. setDisplayMaterial. */
  declare _display: DisplayMode;
  /** Родные материалы мешей на время показа глиной. Ключ — меш, значение — что было. */
  declare _origMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  /**
   * Глина по паре «`side` + цвет автора»: у двусторонних деталей своя, иначе силуэт врёт,
   * а цвет автора глина не стирает и потому входит в ключ. См. `_clayFor`.
   */
  declare _clay: Map<string, THREE.MeshMatcapMaterial>;
  /** Картинка шара для глины. Рисуется один раз при первом показе. */
  declare _clayMap?: THREE.Texture | null;
  /** Материал сетки. Один на всю модель: у сетки нет ни цвета автора, ни сторон. */
  /**
   * Материалы подсветки плотности. Свой у КАЖДОЙ детали — цвет считается по её плотности,
   * общего материала тут быть не может. Держим списком, чтобы освободить при выходе из
   * режима: сцена живёт всё время работы, и мусор в ней копится молча.
   */
  readonly _densityMats = new Set<THREE.MeshBasicMaterial>();
  /**
   * Текстуры ЭТАЛОНА для режима различий, по порядку обхода сцены. Ставит обвязка: одно
   * окно про другое не знает и знать не должно, сравнение — её работа (`ui/viewer/index.ts`).
   *
   * `null` в этом поле у ЛЕВОГО окна — признак, что оно и есть эталон: красится ровно
   * зелёным, сравнивать ему не с чем.
   */
  declare _diffRef?: DiffRef[] | null;
  /** Эталоны, разложенные по имени детали. Строится один раз на смену эталона. */
  declare _diffByName?: Map<string, SlotMaps[]> | null;
  /** Готовые карты различий по деталям. Чистится вместе со сменой эталона, то есть модели. */
  /**
   * Готовые карты различий по НОМЕРУ детали, а не по объекту меша.
   *
   * Номер переживает перезагрузку модели, объект — нет. Александр 2026-09-01: «если в
   * аутлайнере десять моделей… я не хочу, чтобы там всё грузилось 10 часов». Ходя между
   * моделями, человек каждый раз получает НОВЫЕ объекты мешей, и память по объектам не
   * пережила бы ни одного перехода.
   *
   * Саму карту памяти даёт обвязка (`useDiffStore`): она знает, какая пара моделей сейчас
   * показана, а окно — нет.
   */
  /**
   * Память различий: сырое отклонение и готовый цвет. Сырое хранится не про запас — по нему
   * считается подпись «насколько пострадала худшая деталь» (`diffScale`).
   */
  _diffCache = new Map<string, { raw: DiffRaw; tex: THREE.CanvasTexture }>();
  /** Детали, которым карту ещё предстоит посчитать. Обрабатывается по одной за кадр. */
  readonly _diffQueue: Array<{
    mesh: THREE.Mesh; родной: THREE.Material | null; эталон: SlotMaps; ключ: string;
  }> = [];
  declare _diffTimer?: number | null;
  declare _onBusy?: ((busy: boolean) => void) | null;
  /**
   * Общая шкала плотности на оба окна: `[самая редкая, самая плотная]`. Ставит обвязка.
   * `null` — окно считает шкалу по себе (одиночный показ, без пары).
   */
  declare _densityScale?: [number, number] | null;
  /** Габарит модели для глубинного затемнения глины: центр и радиус. */
  declare _clayBounds?: { center: THREE.Vector3; radius: number } | null;
  /** Файлы брошенной пачки — их имена. См. setPackFiles. */
  declare _packFiles: string[];

  /** Подмена адресов для брошенной пачки; null — обычная загрузка. См. setAssetResolver. */
  declare _resolveAsset: ((url: string) => string | null) | null;
  // Появляются после первой удачной загрузки — до неё полей нет вовсе, отсюда `?`.
  declare stats?: ReturnType<typeof computeSceneStats>;
  declare detected?: ReturnType<typeof detectSource>;
  declare clips: THREE.AnimationClip[];
  declare clipIndex?: number;
  declare _mixer?: THREE.AnimationMixer | null;
  declare _action?: THREE.AnimationAction | null;
  /** Привод развёрток текстур по указателю — вне AnimationMixer, см. pointer-uv.ts. */
  declare _uv?: UvPointerDriver | null;
  /** Части, откликающиеся на нажатие СЕЙЧАС. Пусто — интерактива в файле нет. */
  declare _interactive?: InteractivePart[];
  /** Все части из файла — включая те, что граф временно погасил. */
  declare _interactiveAll?: InteractivePart[];
  /** Номера узлов, которым граф снял нажимаемость. */
  declare _interactiveOff?: Set<number>;
  /** Кому рассказать о нажатии — интерфейс пишет об этом в журнал. */
  declare onInteractivePick?: ((part: { name: string; responded: boolean }) => void) | null;
  /** Рамки подсветки, пока они показаны. */
  declare _interactiveMarks?: InteractivityHighlight | null;
  /** Исполнитель графа поведения. null — графа нет либо мы за него не взялись. */
  declare _behaviour?: InteractivityRuntime | null;
  /**
   * Отдельный микшер под анимации, запущенные ГРАФОМ.
   *
   * Почему не общий. Микшер вьюпорта ведёт ОДНУ дорожку по общей полосе времени
   * (`setTime`, абсолютное время, одно на оба окна) и стоит на месте, пока человек не
   * нажал «играть». Граф говорит другое: «запусти вот этот клип прямо сейчас, от такой
   * секунды до такой». Сложить это в один микшер нельзя — второе непрерывно спорило бы
   * с первым за одно и то же время. Поэтому у графа свой, и тикает он настоящим
   * временем кадра, независимо от полосы.
   */
  declare _behaviourMixer?: THREE.AnimationMixer | null;
  /** Когда микшер графа тикал в прошлый раз — для честной дельты. */
  declare _behaviourAt?: number;

  /** Уровни детализации загруженной модели; null — их нет. См. lod.ts. */
  declare _lods?: LodSet | null;
  /** Показанный уровень; null — как в файле. */
  declare _lod?: number | 'all' | null;
  /** Имена вариантов материала (запасные цвета и отделки) — пусто, если их в модели нет. */
  declare _variants?: string[];
  /** Выбранный вариант; null — исходный вид модели, как её отдал экспортёр. */
  declare _variant?: string | null;
  /** Переключатель из плагина: (объект, имя|null) → Promise. Живёт вместе с моделью. */
  declare _selectVariant?: ((o: THREE.Object3D, name: string | null) => Promise<unknown>) | null;
  /** Наш студийный источник. Гасится, когда человек просит показать свет из файла. */
  declare _key: THREE.DirectionalLight;
  /** Источники, которые принесла сама модель (KHR_lights_punctual). Пусто — своих нет. */
  declare _modelLights?: THREE.Light[];
  /** Чей свет показываем: 'studio' — наш, 'file' — авторский, 'none' — никакой. */
  declare _lightMode?: 'studio' | 'file' | 'none';
  /** Камеры, которые автор положил в файл. Пусто — их нет. */
  declare _fileCameras?: FileCamera[];
  /** Через какую камеру смотрим: номер авторской либо null — через нашу орбитальную. */
  declare _cameraIndex?: number | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.model = null;
    // Счётчик загрузок: результат отстающей загрузки в сцену не попадает (см. load()).
    this._loadToken = 0;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initControls();
    this._initLights();
    this._initLoaders();

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(canvas.parentElement!);
    this._onResize();
    this._initPicking();
  }

  /**
   * Нажатие мышью по нажимаемой части — то, ради чего интерактив и проигрывается.
   *
   * ОТЛИЧАЕМ НАЖАТИЕ ОТ ВРАЩЕНИЯ ПО СДВИГУ, И ТОЛЬКО ПО НЕМУ. Тот же холст крутит
   * камеру, и без различия каждый поворот запускал бы отклики. Пять пикселей — рука
   * дрожит, а вращают заметно дальше.
   *
   * ВРЕМЕНИ ЗДЕСЬ НЕТ, и это исправление, а не упрощение. Первая редакция считала
   * нажатием только то, что уложилось в полсекунды, — и Александр сообщил, что «многие
   * кнопки не работают». Так и есть: осмысленное нажатие по маленькой кнопке (навёл,
   * посмотрел, отпустил) в полсекунды не укладывается, а держать кнопку нажатой — не
   * вращение. Долгое нажатие без сдвига — всё равно нажатие.
   */
  _initPicking() {
    let startX = 0;
    let startY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 5) return;
      const box = this.canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      this.pickInteractive((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
    });
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  _initScene() {
    this.scene = new THREE.Scene();

    // Нейтральный студийный IBL, генерируется процедурно — ничего не грузим с диска.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  _initCamera() {
    // Позиция/near/far выставляются в frame() после загрузки, под размер модели.
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(0, 0, 5);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
  }

  _initLights() {
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(8, 12, 6);
    this.scene.add(key);
    this._key = key;
    this._lightMode = 'studio';
  }

  _initLoaders() {
    // ОДИН менеджер на все три загрузчика. Через него проходит каждый адрес, за которым
    // движок собирается пойти, — и только так `.gltf` из брошенной пачки находит свои
    // соседние файлы: их нет ни на сервере, ни в сети, они лежат в памяти вкладки.
    //
    // Менеджер общий не для красоты. Загрузчики берут адрес из СВОЕГО менеджера: дай
    // GLTFLoader-у наш, а KTX2Loader-у оставь его собственный — и пачка с текстурами в
    // KTX2 (а их кладут отдельными файлами именно так) осталась бы без картинок, причём
    // молча: `.bin` нашёлся, модель показана, текстур нет.
    //
    // Свои пути декодеров (`/vendor/three/…`) подмену проходят насквозь: они не
    // относятся к пачке, и resolveAsset отвечает про них `null`.
    this._manager = new THREE.LoadingManager();
    this._resolveAsset = null;
    this._packFiles = [];
    this._display = 'file';
    this._origMaterials = new Map();
    this._clay = new Map();
    this._manager.setURLModifier((url: string) => (this._resolveAsset && this._resolveAsset(url)) || url);

    this._draco = new DRACOLoader(this._manager);
    this._draco.setDecoderPath(DRACO_DECODER_PATH);

    this._ktx2 = new KTX2Loader(this._manager);
    this._ktx2.setTranscoderPath(KTX2_TRANSCODER_PATH);
    this._ktx2.detectSupport(this.renderer);

    this._loader = new GLTFLoader(this._manager);
    this._loader.setDRACOLoader(this._draco);
    this._loader.setKTX2Loader(this._ktx2);
    this._loader.setMeshoptDecoder(MeshoptDecoder);

    // KHR_animation_pointer — анимация по УКАЗАТЕЛЮ в JSON, а не по узлу сцены:
    // «яркость материала 2», «поворот развёртки текстуры». Загрузчик three.js такие
    // каналы выбрасывает молча (GLTFLoader.js: `if (target.node === undefined) continue`),
    // и модель приезжает с пустым клипом — снаружи неотличимо от модели без анимации.
    //
    // Для нас это была слепая зона: дефект, при котором указатели съезжают после
    // схлопывания одинаковых текстур, глазами не проверялся вообще — только чтением JSON.
    //
    // Три факта про плагин, проверенных по его исходнику 2026-08-14, чтобы будущему
    // читателю не пришлось лезть в node_modules:
    //   1. Он ФОРК метода GLTFLoader.loadAnimation («MOSTLY DUPLICATE» в его же
    //      комментарии). Значит при обновлении three.js копия может разойтись с
    //      оригиналом — сверять при смене версии three, см. docs/ЗАВИСИМОСТИ.md.
    //   2. Он патчит THREE.PropertyBinding.findNode ГЛОБАЛЬНО. Патч ленивый: ставится
    //      только когда в модели реально встретился канал по указателю. Обычные модели
    //      его не касаются вовсе.
    //   3. Патч перехватывает только пути `.materials.`, `.nodes.`, `.lights.`,
    //      `.cameras.`; всё остальное уходит в исходную функцию. Обычные дорожки
    //      («Cube.position») под эти префиксы не подпадают — столкновения нет.
    //
    // Предохранитель: регистрация в try/catch. Плагин — вспомогательный, и модель
    // обязана открыться даже если он не завёлся: без анимации хуже, чем с ней, но
    // несравнимо лучше пустого вьюпорта.
    try {
      // Порядок важен только по смыслу, не по механике: сторож работает в beforeRoot,
      // то есть до того, как кто-либо возьмётся за анимации.
      this._loader.register((parser) => orphanPointerGuard(parser));
      this._loader.register((parser) => new GLTFAnimationPointerExtension(parser));
      // Варианты материала — запасные цвета и отделки, между которыми модель умеет
      // переключаться. Загрузчик three.js их не читает: расширение вынесено в отдельный
      // плагин, ссылка на который стоит в документации самого GLTFLoader. Без плагина
      // показывается один вид, и человек не знает, что художник сделал ещё три.
      this._loader.register((parser) => new GLTFMaterialsVariantsExtension(parser));
      // Просвет насквозь (лист, абажур, тонкий фарфор). У three.js 0.185.1 расширения
      // нет вовсе — ни свойства, ни ветки загрузчика, — и модель показывалась плотной,
      // хотя в файл оно доезжает целым. Разбор — в `diffuse-transmission.ts`.
      this._loader.register((parser) => new GLTFDiffuseTransmissionExtension(parser));
    } catch (err) {
      console.warn('KHR_animation_pointer: плагин не зарегистрирован, анимация по указателю показана не будет', err);
    }
  }

  /**
   * Загрузить модель по URL. Предыдущая модель выгружается (dispose) — просмотрщик
   * переиспользуется для перезагрузки (оригинал → оптимизированный и т.п.).
   */
  async load(url: string, { onProgress, camera = null, format = null }: LoadOptions = {}) {
    // Метка этой загрузки. Разбор GLB — это секунды, и за них человек успевает нажать
    // «Пересобрать» или переключить модель. Раньше это кончалось так: обе загрузки
    // проходили _disposeModel() по ЕЩЁ ПУСТОЙ сцене, а потом обе добавляли свою модель.
    // Вторая записывалась в this.model, первая оставалась в сцене навсегда — никем не
    // отслеживаемая, невыгружаемая, поверх новой. На экране это выглядело как «куча
    // объектов» и огромный светящийся блок: две модели разного масштаба в одном кадре,
    // камера наведена на одну из них.
    const token = ++this._loadToken;
    this._disposeModel();

    const gltf = FOREIGN_FORMATS.includes(String(format || '').toLowerCase())
      ? await this._loadForeign(url, String(format).toLowerCase())
      : await this._loader.loadAsync(url, onProgress);
    // Пока разбирали файл, началась следующая загрузка — эта устарела. Свою модель
    // освобождаем сами: в сцену она не попала, и _disposeModel() до неё не доберётся.
    if (token !== this._loadToken) {
      disposeSubtree(gltf.scene);
      return null;
    }
    this.model = gltf.scene;
    this.scene.add(this.model);
    // Развёртки текстур ведём сами (ui/viewer/pointer-uv.ts): плагин их дорожки создаёт,
    // но привязать не может — в glTF слот зовётся normalTexture, в three.js normalMap.
    // Свои дорожки он ставит ПОСЛЕ, поэтому забираем их из клипа, иначе они каждый кадр
    // жалуются в консоль и всё равно ничего не двигают.
    this._uv = await buildUvPointerDriver(gltf);
    if (this._uv) stripUvTransformTracks(gltf.animations || []);
    this._readVariants(gltf);
    // Уровни детализации ищем ПОСЛЕ добавления модели в сцену: соседей узнаём по
    // габаритам, а они считаются по мировым матрицам.
    this._lods = await detectLods(gltf as never);
    this._lod = null;
    // Спрятанное автором прячем ДО того, как считать габариты и строить рамки: узел,
    // которого в файле не видно, не должен ни показываться, ни попадать в кадр.
    applyNodeVisibility(gltf as never);
    // Нажимаемые части. Ищем ПОСЛЕ добавления модели в сцену — рамки строятся по мировым
    // габаритам, а до этого их не посчитать.
    this._interactiveAll = findInteractive(gltf as never);
    this._interactiveOff = new Set<number>();
    this._interactive = [...this._interactiveAll];
    this._interactiveMarks = null;
    // Показываем СРАЗУ, не дожидаясь нажатия. Прямое требование Александра 2026-08-28:
    // «мне важно что бы видно было интерактивные элементы». Первая редакция прятала
    // обводку за кнопкой — он загрузил MagicBall с Calculator и не увидел ничего, потому
    // что кнопку надо было ещё найти и нажать. Показанное по умолчанию отвечает на
    // вопрос сразу; кнопка остаётся, чтобы обводку СНЯТЬ.
    if (this._interactive.length) this.setInteractivityMarks(true);
    // Свой свет модели считаем после добавления в сцену: загрузчик кладёт источники
    // внутрь модели, и до этого момента обходить нечего. Режим при новой модели всегда
    // студийный — иначе модель без своих источников открылась бы почти чёрной.
    this._modelLights = this._collectModelLights();
    this.setLightMode('studio');
    // Камеры автора и свет сбрасываются на своё умолчание при каждой модели по одной
    // причине: у следующей их может не быть вовсе.
    this._readFileCameras(gltf);
    this.setCamera(null);
    this._setupAnimations(gltf.animations);
    // Исполнитель графа поднимается ПОСЛЕ анимаций, и порядок здесь не украшение.
    // Первая редакция звала его выше — до `_setupAnimations`, — и он забирал `clips`
    // пустыми, а микшер `null`. Каждый `animation/start` уходил в никуда: WhackAMole и
    // MagicBall показывали обводку и не двигались вовсе (Александр, 2026-08-28).
    this._startBehaviour(gltf as never);
    // camera передан (сборка/ребилд той же модели) → СОХРАНИТЬ ракурс: приближённая
    // пользователем деталь остаётся на месте. Иначе (новая модель) — авто-кадрирование.
    if (camera) this.applyCameraState(camera);
    else this.frame();
    this.stats = computeSceneStats(this.model);
    this.detected = detectSource(gltf);
    // Режим показа переживает смену модели: человек выбрал его для сравнения, и
    // самовольно возвращаться к родным материалам на следующей модели нельзя.
    this._applyDisplayMaterial();
    return gltf;
  }

  /**
   * Чем показывать модель: её собственными материалами или нашей глиной.
   *
   * Это РЕЖИМ ПОКАЗА, а не правка. Родные материалы сохраняются целиком и возвращаются на
   * место по первому же переключению и перед выгрузкой модели; в файл не попадает ничего,
   * выгрузка отдаёт ровно то, что человек принёс (Правило 11: мы оптимизатор, не редактор).
   *
   * `side` берём у родного материала: двусторонняя деталь, показанная односторонней,
   * теряет половину поверхности — а именно ради формы всё и затевалось. Прозрачность
   * НАМЕРЕННО не переносим: сквозь глину и должно быть непрозрачно, иначе внутренние
   * стенки просвечивают и форма читается хуже, чем у белой модели.
   */
  setDisplayMaterial(mode: DisplayMode) {
    this._display = DISPLAY_MODES.includes(mode) ? mode : 'file';
    this._applyDisplayMaterial();
    return true;
  }

  getDisplayMaterial(): DisplayMode {
    return this._display;
  }

  /**
   * Плотность детали: треугольников на единицу ПЛОЩАДИ её габаритной коробки.
   *
   * ПОЧЕМУ ПЛОЩАДЬ, А НЕ ОБЪЁМ. Замысел Александра звучал про объём («весь дом 100
   * кубометров, окно один»), и в этом виде он НЕ РАБОТАЕТ — проверено замером 2026-09-01
   * (`_work/density-measure.mjs`). У плоской детали объём коробки почти ноль, и плотность
   * взрывается: первым шло стекло часов на 62 треугольника (0,06% модели), а настоящая
   * тяжёлая деталь на 38 668 из топа выпадала.
   *
   * Треугольники покрывают ПОВЕРХНОСТЬ, поэтому делить надо на неё. С площадью замер
   * сходится: у часов в первую пятёрку попали обе настоящие тяжёлые детали, у машины —
   * дворники.
   */
  _densityOf(mesh: THREE.Mesh): number {
    const g = mesh.geometry as THREE.BufferGeometry;
    if (!g) return 0;
    const index = g.getIndex();
    const pos = g.getAttribute('position');
    if (!pos) return 0;
    const треугольников = (index ? index.count : pos.count) / 3;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return 0;
    // Нулевая сторона у плоской детали заменяется малой: иначе площадь нулевая и всё
    // деление теряет смысл. Значение взято заведомо меньше любой осмысленной детали.
    const сторона = (x: number) => Math.max(Number.isFinite(x) ? x : 0, 1e-4);
    const dx = сторона(bb.max.x - bb.min.x);
    const dy = сторона(bb.max.y - bb.min.y);
    const dz = сторона(bb.max.z - bb.min.z);
    const площадь = 2 * (dx * dy + dy * dz + dx * dz);
    return площадь > 0 ? треугольников / площадь : 0;
  }

  /**
   * Материал подсветки плотности для одной детали.
   *
   * ШКАЛА ЛОГАРИФМИЧЕСКАЯ и ОТНОСИТЕЛЬНАЯ — два решения, и оба обязательные.
   *
   * Логарифм: плотности расходятся на порядки (замер по `CarConcept`: от 1,4·10⁵ у самой
   * плотной детали до сотых долей у самой редкой). На линейной шкале всё, кроме одной
   * детали, слилось бы в один цвет, и подсветка перестала бы отвечать на вопрос.
   *
   * Относительность: абсолютного порога «сколько треугольников на метр — много» не
   * существует, потому что метра у модели нет. Единицы задаёт автор: у одного дом в
   * метрах, у другого тот же дом в сантиметрах. Поэтому шкала растягивается по САМОЙ
   * МОДЕЛИ: самая плотная деталь — красная, самая редкая — зелёная. Это отвечает на
   * вопрос «где дорого У МЕНЯ», а не «дорого ли это вообще».
   *
   * `MeshBasicMaterial`, как у сетки: цвет обязан читаться точно, а не через свет.
   */
  _densityFor(mesh: THREE.Mesh, min: number, max: number) {
    const v = this._densityOf(mesh);
    const lg = (x: number) => Math.log10(Math.max(x, 1e-9));
    const a = lg(min);
    const b = lg(max);
    // Все детали одинаковой плотности — красить нечего, показываем ровный холодный цвет.
    const t = b - a > 1e-6 ? Math.min(1, Math.max(0, (lg(v) - a) / (b - a))) : 0;
    const color = new THREE.Color();
    // Зелёный → жёлтый → красный: привычная тепловая шкала, читается без легенды.
    color.setHSL((1 - t) * 0.33, 0.85, 0.5);
    return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
  }

  /**
   * Слоты карт, которые сравниваются. Один список на весь режим — второй разошёлся бы.
   *
   * Замечание Александра 2026-09-01: «текстура нормал мапы точно не учитывается, а она
   * тоже должна учитываться и должно усредняться значение». Он прав: базовый цвет — лишь
   * одна из карт, и потеря в нормалях меняет вид модели не меньше.
   *
   * Имена трёхмерные (`normalMap`), а не из спецификации glTF (`normalTexture`): здесь мы
   * работаем с уже загруженным материалом движка. `metalnessMap` и `roughnessMap` у glTF
   * обычно одна и та же картинка — посчитается дважды, и это не беда: вес у слотов равный,
   * а лишний одинаковый голос ничего не искажает.
   */
  /**
   * Отклонение, при котором цвет упирается в красный. Доля от полной яркости.
   *
   * ЧИСЛО ВЗЯТО ИЗ ЗАМЕРА, а не из головы (`_work/slot-stats.mjs`, две модели по трём
   * настройкам). Худшая деталь теряет:
   *
   *              webp 0   webp 90   уменьшение до 512
   *   ABeautifulGame  3,6%     2,1%     3,1%
   *   CarConcept     12,2%     7,7%     8,5%
   *
   * То есть настоящие потери живут в единицах процентов, а не в десятках: пять процентов
   * сдвига яркости — это уже хорошо заметная глазу порча. При пороге в 5% шахматы на нуле
   * дают три четверти шкалы (оранжево-красный), машина упирается в потолок, а сборка без
   * изменений остаётся зелёной.
   *
   * Порог ПОСТОЯННЫЙ, один на все модели. Относительный (растянуть по самой модели) уже
   * пробовали 2026-09-04 и откатили в тот же день: «даже при визуальном отсутствии
   * изменения всё покраснело». Постоянный порог позволяет сравнивать две сборки между
   * собой — зелёное значит одно и то же всегда.
   *
   * Шкала ЛИНЕЙНАЯ. Прежняя степень 0,4 поднимала мелочь, пока потолком была полная
   * яркость; с порогом в 5% поднимать больше нечего, а прямая линия предсказуема:
   * половина шкалы — это ровно 2,5%.
   */
  static readonly ПОЛНЫЙ_КРАСНЫЙ = 0.05;

  /** До какого размера приводятся карты при сравнении. Почему — см. `_diffRaw`. */
  static readonly ПОТОЛОК_СРАВНЕНИЯ = 1024;

  /**
   * Окно SSIM в пикселях. Восемь — общепринятый размер: меньше ловит шум вместо структуры,
   * больше размазывает границу между целым и испорченным.
   */
  static readonly ОКНО_SSIM = 8;

  /** Потеря структуры, при которой цвет упирается в красный. Взято замером — см. `_diffRaw`. */
  static readonly ПОРОГ_SSIM = 0.25;

  static readonly DIFF_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;

  /**
   * Карта различий: где пиксели те же — зелено, где ушли — красно. По ВСЕМ картам сразу.
   *
   * РАЗРЕШЕНИЕ — НАИБОЛЬШЕЕ среди эталонных карт, и вниз мы не приводим никогда. Решение
   * Александра: «приводить к меньшему из двух не нужно, просто накладывай новые пиксели на
   * старые крупные». Так один пиксель тысячной текстуры ложится на четыре пикселя
   * двухтысячной, и видно ОБЕ потери — от пережатия и от уменьшения. Обе настоящие:
   * «просишь уменьшить — нужно понимать, что будут потери».
   *
   * ВНУТРИ СЛОТА — максимум по каналам, МЕЖДУ СЛОТАМИ — среднее.
   *
   * Максимум внутри: среднее спрятало бы сдвиг одного цвета — красный, уехавший на треть,
   * вместе с целыми зелёным и синим даёт «одну девятую», и карта промолчала бы о том, что
   * человек видит глазами.
   *
   * Среднее между: иначе одна испорченная карта из шести красила бы деталь целиком, и
   * стало бы не отличить «рассыпался нормал» от «рассыпалось всё».
   */
  /**
   * СЫРОЕ отклонение пары карт: байт на пиксель плюс наибольшее значение.
   *
   * Цвет здесь НЕ выбирается намеренно. Шкала относительная — красным становится самое
   * сильное отклонение ЭТОЙ модели, — а узнать его можно только обойдя все пары. Поэтому
   * счёт и раскраска разведены: сначала считаем, потом красим, зная предел.
   */
  /**
   * Пиксели текстуры — ЧЕРЕЗ ВИДЕОКАРТУ, а не через холст.
   *
   * ДЕФЕКТ, найденный Александром 2026-09-04: «почему у нас на ktx2 это не работает
   * вообще». Ответ был в консоли: `drawImage … The provided value is not of type
   * (HTMLCanvasElement or HTMLImageElement …)`.
   *
   * KTX2 приходит в сцену как `CompressedTexture`: её пиксели лежат в формате самой
   * видеокарты (UASTC/ETC1S), в оперативной памяти их нет вовсе, и нарисовать её на холсте
   * нельзя в принципе. Исключение падало прямо в шаге очереди и убивало ВЕСЬ расчёт —
   * модель оставалась серой, а кубик не гас.
   *
   * Выход один и он же общий: попросить нарисовать текстуру ту самую видеокарту, которая
   * умеет её читать, и снять готовые пиксели. Путь получается ОДИН для всех форматов —
   * PNG, JPEG, WebP, KTX2, — и это ценнее, чем разбор случаев: сравнение перестаёт зависеть
   * от того, чем текстура сжата.
   *
   * ЦВЕТОВОЕ ПРОСТРАНСТВО приёмника берётся у источника. Тогда преобразование при чтении
   * (sRGB → линейное) и обратное при записи гасят друг друга, и байты остаются теми же, что
   * в файле, — иначе порог в 5% пришлось бы мерить заново.
   *
   * ПОРЯДОК СТРОК у видеокарты снизу вверх, у холста сверху вниз. Переворачиваем здесь, а
   * не потом: дальше пиксели сравниваются с эталоном, снятым тем же способом, и любая
   * невязка была бы общей — то есть незаметной и потому опасной.
   */
  _пикселиТекстуры(t: THREE.Texture | null | undefined, w: number, h: number): Uint8ClampedArray | null {
    const img = t?.image as { width?: number } | undefined;
    if (!t || !img || !img.width) return null;
    if (!this.renderer) return null;

    // ОДНА ТЕКСТУРА — ОДНО ЧТЕНИЕ. У шахмат 49 материалов на 33 текстуры, и половина карт
    // общая: без этой памяти одна и та же картинка снималась бы с видеокарты по нескольку
    // раз. Память живёт ровно один расчёт (чистится вместе с очередью).
    const ключ = `${t.uuid}:${w}x${h}`;
    const уже = this._пиксели?.get(ключ);
    if (уже) return уже;

    if (!this._съёмник) {
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const material = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
      this._съёмник = { scene, camera, material, rt: null, w: 0, h: 0 };
    }
    const с = this._съёмник;
    if (!с.rt || с.w !== w || с.h !== h) {
      с.rt?.dispose();
      // ВЕЩЕСТВЕННЫЙ приёмник, а не байтовый.
      //
      // Видеокарта раскодирует sRGB САМА, на уровне формата текстуры: в шейдер приходит уже
      // линейное значение, и никакой настройкой это не отменить. Значит вернуть sRGB надо
      // нам, а линейное в восьми битах для этого не годится — тёмные тона схлопываются в
      // единицы (0x30 превращался в 8, и обратно уже не разворачивался).
      //
      // Поймано пробой на красноту: первая редакция проверки брала текстуру с пространством
      // по умолчанию и проходила при любой ошибке.
      с.rt = new THREE.WebGLRenderTarget(w, h, {
        magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false,
        type: THREE.FloatType,
      });
      с.w = w; с.h = h;
    }
    с.rt.texture.colorSpace = t.colorSpace;
    с.material.map = t;
    с.material.needsUpdate = true;

    const прежняя = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(с.rt);
    this.renderer.render(с.scene, с.camera);
    const сырое = new Float32Array(w * h * 4);
    this.renderer.readRenderTargetPixels(с.rt, 0, 0, w, h, сырое);
    this.renderer.setRenderTarget(прежняя);
    с.material.map = null;

    // ОБРАТНО В sRGB — для тех карт, что в нём и лежали. Карты данных (нормали,
    // шероховатость) помечены линейными, их не трогаем: они и в файле линейные.
    const вSRGB = t.colorSpace === THREE.SRGBColorSpace;
    const байт = (v: number) => {
      const л = Math.min(1, Math.max(0, v));
      const s = вSRGB ? (л <= 0.0031308 ? л * 12.92 : 1.055 * Math.pow(л, 1 / 2.4) - 0.055) : л;
      return Math.round(s * 255);
    };

    // ПОРЯДОК СТРОК ЗАВИСИТ ОТ `flipY` ИСХОДНОЙ ТЕКСТУРЫ, и это не мелочь.
    //
    // Видеокарта отдаёт кадр снизу вверх, холст читается сверху вниз — значит строки надо
    // перевернуть. Но перевернуть НЕ ВСЕГДА: `flipY` решает, какой стороной картинка легла
    // на видеокарту при загрузке.
    //
    //   flipY = true  — на видеокарте низ картинки внизу; наш кадр приходит перевёрнутым,
    //                   и переворот его выправляет.
    //   flipY = false — картинка уже лежит как есть, и второй переворот ЛОМАЕТ её.
    //
    // Второй случай — не редкость, а НОРМА: у всех текстур из glTF `flipY` равен `false`.
    // То есть на каждой настоящей модели карта различий ложилась вверх ногами, и красное
    // показывалось на противоположной половине текстуры. Именно так это и выглядело у
    // Александра на `SheenWoodLeather`: «самая красная часть на глаз поломана меньше всего».
    //
    // Поймано сторожем, которого до 2026-09-05 не было вовсе: перевёрнутая карта выглядит
    // правдоподобно — цвета те же, распределение похожее, — и глазами её замечаешь только
    // на модели с явной асимметрией.
    const перевернуть = t.flipY;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const из = (перевернуть ? h - 1 - y : y) * w * 4;
      const в = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        out[в + x] = байт(сырое[из + x]!);
        out[в + x + 1] = байт(сырое[из + x + 1]!);
        out[в + x + 2] = байт(сырое[из + x + 2]!);
        out[в + x + 3] = Math.round(Math.min(1, Math.max(0, сырое[из + x + 3]!)) * 255);
      }
    }
    if (!this._пиксели) this._пиксели = new Map();
    this._пиксели.set(ключ, out);
    return out;
  }

  _diffRaw(эталоны: SlotMaps, ставшие: SlotMaps): DiffRaw | null {
    const слоты = Viewer.DIFF_SLOTS.filter((k) => {
      const и = эталоны[k]?.image as { width?: number } | undefined;
      return !!и?.width;
    });
    if (!слоты.length) return null;

    let w = 0;
    let h = 0;
    for (const k of слоты) {
      const и = эталоны[k]!.image as { width: number; height: number };
      if (и.width > w) { w = и.width; h = и.height; }
    }
    // ПОТОЛОК РАЗРЕШЕНИЯ СРАВНЕНИЯ.
    //
    // Снятие пикселей с видеокарты — синхронное чтение назад, и на 2048×2048 это 16 МБ за
    // раз, до двенадцати раз на материал. Очередь переставала успевать, и модель подолгу
    // стояла серой (замер в живом окне: KTX2 на шахматах не досчитывался и за восемь секунд).
    //
    // Тысяча двадцать четыре — вчетверо меньше работы. Карта различий смотрится на модели
    // целиком, а не под лупой, и разницы там не видно; сама же мера от этого не страдает:
    // ОБЕ стороны приводятся к одному размеру, и потеря деталей по-прежнему считается между
    // ними, а не между ними и оригиналом.
    if (w > Viewer.ПОТОЛОК_СРАВНЕНИЯ) {
      h = Math.max(1, Math.round(h * (Viewer.ПОТОЛОК_СРАВНЕНИЯ / w)));
      w = Viewer.ПОТОЛОК_СРАВНЕНИЯ;
    }

    const снять = (t: THREE.Texture | null | undefined) => this._пикселиТекстуры(t, w, h);

    const пары: Array<[Uint8ClampedArray, Uint8ClampedArray | null]> = [];
    for (const k of слоты) {
      const a = снять(эталоны[k]);
      if (a) пары.push([a, снять(ставшие[k])]);
    }
    if (!пары.length) return null;

    // ЧТО СЧИТАЕТСЯ ПОТЕРЕЙ: SSIM плюс сдвиг цвета, и берётся БОЛЬШЕЕ.
    //
    // Путь до этой меры занял день и три редакции, каждая по замечанию Александра.
    //
    //   Разница пикселей — «модель поехала, а окно зелёное». Уменьшение 2048 → 512 меняет
    //   пиксели всего на 2,7%: размытая картинка численно близка к исходной.
    //
    //   Плюс убыль локального контраста — стало лучше, но мера осталась самодельной, а
    //   порог к ней подбирался руками.
    //
    //   SSIM — то, чем эту задачу решают везде. По сверке с людьми (Cloudinary,
    //   SSIMULACRA): разница пикселей угадывает человеческую оценку в 67% случаев,
    //   Butteraugli в 80%, SSIM-подобные в 82–87%. Слово Александра 2026-09-04: «делай ssim».
    //
    // SSIM смотрит не на значения, а на СТРУКТУРУ в окне: среднее, разброс и то, насколько
    // согласованно они меняются. Размытие валит его сразу — потому что исчезает именно
    // разброс, — а равномерный сдвиг яркости почти не трогает.
    //
    // ЗАЧЕМ РЯДОМ ОСТАЁТСЯ СДВИГ ЦВЕТА. SSIM считается по яркости, и перекраску при той же
    // яркости (зелёный в серый) он не увидит. Такое бывает у палитр и у сильного сжатия
    // цветности. Два сигнала, каждый со своим порогом, приведены к общей доле шкалы и
    // сведены максимумом: единица — полный красный.
    const N = w * h;
    const яркость = (a: Uint8ClampedArray, i: number) => 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!;

    /**
     * Карта потери структуры, 0…1 на пиксель. Скользящее окно, суммы — интегральные,
     * поэтому цена не зависит от размера окна.
     */
    const ssimПотеря = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      const X = new Float32Array(N);
      const Y = new Float32Array(N);
      for (let p = 0, i = 0; p < N; p++, i += 4) { X[p] = яркость(a, i); Y[p] = яркость(b, i); }

      // Интегральные суммы: (w+1)×(h+1), чтобы не проверять края в цикле.
      const ш = w + 1;
      const сумма = (f: (p: number) => number) => {
        const S = new Float64Array(ш * (h + 1));
        for (let y = 0; y < h; y++) {
          let строка = 0;
          for (let x = 0; x < w; x++) {
            строка += f(y * w + x);
            S[(y + 1) * ш + x + 1] = S[y * ш + x + 1]! + строка;
          }
        }
        return S;
      };
      const Sx = сумма((p) => X[p]!);
      const Sy = сумма((p) => Y[p]!);
      const Sxx = сумма((p) => X[p]! * X[p]!);
      const Syy = сумма((p) => Y[p]! * Y[p]!);
      const Sxy = сумма((p) => X[p]! * Y[p]!);
      const окно = (S: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
        S[y1 * ш + x1]! - S[y0 * ш + x1]! - S[y1 * ш + x0]! + S[y0 * ш + x0]!;

      // Постоянные из статьи Ванга: C1 = (0,01·L)², C2 = (0,03·L)² при L = 255.
      const C1 = 6.5025;
      const C2 = 58.5225;
      const r = Viewer.ОКНО_SSIM >> 1;
      const out = new Float32Array(N);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - r);
          const x1 = Math.min(w, x + r + 1);
          const n = (x1 - x0) * (y1 - y0);
          const mx = окно(Sx, x0, y0, x1, y1) / n;
          const my = окно(Sy, x0, y0, x1, y1) / n;
          const vx = окно(Sxx, x0, y0, x1, y1) / n - mx * mx;
          const vy = окно(Syy, x0, y0, x1, y1) / n - my * my;
          const cxy = окно(Sxy, x0, y0, x1, y1) / n - mx * my;
          // ТОЛЬКО ЧАСТЬ ПРО СТРУКТУРУ, без множителя яркости.
          //
          // Полный SSIM состоит из трёх частей: яркость, контраст, структура. Первая у нас
          // лишняя — сдвиг яркости уже меряет отдельный сигнал со своим порогом, и считать
          // его дважды значит удваивать вес одной и той же потери.
          //
          // Хуже того, множитель яркости обманывает на ровных тёмных заливках: у двух
          // однотонных пятен разброса нет вовсе, и всё решает отношение средних — 0x02
          // против 0x04 давало «потерю» в 15%, хотя структуре терять было нечего. Поймано
          // собственным сторожем: «мелкое изменение покрашено как разгром».
          //
          // Без него у двух ровных пятен выходит ровно единица, то есть «структура цела», —
          // и это правда.
          const s = (2 * cxy + C2) / (vx + vy + C2);
          void mx; void my; void C1;
          out[y * w + x] = Math.min(1, Math.max(0, 1 - s));
        }
      }
      return out;
    };

    const потери = пары.map(([a, b]) => (b ? ssimПотеря(a, b) : null));

    const data = new Uint8Array(N);
    let max = 0;
    let суммаSSIM = 0;
    let считано = 0;
    for (let i = 0, p = 0; p < N; i += 4, p++) {
      let худшее = 0;
      for (let к = 0; к < пары.length; к++) {
        const [a, b] = пары[к]!;
        if (!b) continue;
        // Сдвиг цвета — в долях своего порога.
        let цвет = 0;
        for (let n = 0; n < 3; n++) цвет = Math.max(цвет, Math.abs(a[i + n]! - b[i + n]!));
        const доляЦвета = цвет / (255 * Viewer.ПОЛНЫЙ_КРАСНЫЙ);
        // Потеря структуры — в долях своего.
        const п = потери[к]![p]!;
        суммаSSIM += п;
        считано++;
        const доляSSIM = п / Viewer.ПОРОГ_SSIM;
        // МАКСИМУМ ПО КАРТАМ (Александр 2026-09-04: «если металл не изменился, а нормалмапа
        // разошлась на 10%, мы и берём 10%») и максимум между двумя сигналами.
        const это = Math.max(доляЦвета, доляSSIM);
        if (это > худшее) худшее = это;
      }
      const v = Math.round(Math.min(1, худшее) * 255);
      data[p] = v;
      if (v > max) max = v;
    }
    let всего = 0;
    for (let p = 0; p < N; p++) всего += data[p]!;
    return {
      data, w, h, max, среднее: всего / N,
      ssim: считано ? 1 - суммаSSIM / считано : 1,
      flipY: эталоны[слоты[0]!]!.flipY,
    };
  }

  /**
   * Счёт и раскраска одним вызовом — для точечных проверок.
   */
  _diffTexture(эталоны: SlotMaps, ставшие: SlotMaps): THREE.CanvasTexture | null {
    const сырое = this._diffRaw(эталоны, ставшие);
    return сырое ? this._diffColor(сырое) : null;
  }

  /**
   * Покрасить сырое отклонение. Шкала АБСОЛЮТНАЯ: 0 — цело, полная яркость — красный.
   *
   * ОТКАТ, сделанный по слову Александра 2026-09-04: «сейчас даже при визуальном отсутствии
   * изменения всё покраснело. Откатывай, до этого было точно лучше».
   *
   * Относительная шкала (красным — самая пострадавшая деталь ЭТОЙ модели) была его же
   * заказом, и он же назвал её опасность заранее: «при небольшом изменении всё будет
   * красным». Опасность оказалась главнее пользы — и это разумно: у цвета должно быть
   * ПОСТОЯННОЕ значение. Зелёный обязан означать «цело» в любой модели, иначе две сборки
   * рядом не сравнить, а человек, увидевший красное, каждый раз должен искать подпись,
   * чтобы понять, испугался он зря или нет.
   *
   * Потолок шкалы — `ПОЛНЫЙ_КРАСНЫЙ`, и он взят из замера: см. его же шапку.
   *
   * Насколько пострадала худшая деталь, человек по-прежнему видит числом — `diffScale()`.
   * Число рядом с постоянной шкалой отвечает на оба вопроса сразу: «где» показывает цвет,
   * «насколько» — подпись.
   */
  _diffColor(сырое: DiffRaw): THREE.CanvasTexture | null {
    const { data, w, h } = сырое;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const карта = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < data.length; p++, i += 4) {
      // Сигнал УЖЕ приведён к шкале в `_diffRaw`: 255 — это полный красный. Делить его на
      // порог второй раз значило бы применить порог дважды — так и вышло при переходе на
      // SSIM, и мелкое изменение сразу стало «разгромом».
      const t = data[p]! / 255;
      // ЗЕЛЁНЫЙ → ЖЁЛТЫЙ → КРАСНЫЙ. Прежняя пара «красный = t, зелёный = 1 − t» давала в
      // середине шкалы тёмный оливковый: самый спорный участок выглядел самым грязным.
      // Через жёлтый середина ЯРЧЕ краёв, и «немного тронуто» не сливается с «цело».
      карта.data[i] = Math.round(255 * (t < 0.5 ? t * 2 : 1));
      карта.data[i + 1] = Math.round(255 * (t < 0.5 ? 1 : 2 - t * 2));
      карта.data[i + 2] = 40;
      карта.data[i + 3] = 255;
    }
    ctx.putImageData(карта, 0, 0);
    const tex = new THREE.CanvasTexture(out);
    tex.flipY = сырое.flipY;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Материал одной детали в режиме различий.
   *
   * ЛЕВОЕ ОКНО — ЭТАЛОН и красится ровно зелёным: у него отклонений нет по определению, и
   * считать ему карту значило бы тратить работу на известный заранее ответ.
   *
   * СОПОСТАВЛЕНИЕ ПО ПОРЯДКУ ОБХОДА, и это честная слабость. Обе модели — одна сцена, и
   * порядок деталей совпадает, пока сборка не меняет их состав. Склейка мешей его меняет:
   * пара «эталон ↔ результат» разъезжается, эталона на месте нет, и деталь остаётся
   * зелёной. Мы молчим, а не показываем чужую разницу — врать хуже, чем не ответить.
   */
  _texdiffFor(родной: THREE.Material | null, эталон: SlotMaps, ключ: string) {
    const готовая = this._diffCache.get(ключ);
    if (готовая) return this._картой(готовая.tex, Viewer._откудаРазмещение(родной));

    const m = родной as THREE.MeshStandardMaterial | null;
    const ставшие: SlotMaps = {};
    for (const k of Viewer.DIFF_SLOTS) ставшие[k] = (m?.[k] as THREE.Texture | null) || null;

    const raw = this._diffRaw(эталон, ставшие);
    // Не посчиталось (карта эталона ещё не раскодирована) — молчим стеклом, а не зеленью:
    // зелёный означает «сравнили, отклонений нет», и здесь это было бы неправдой.
    if (!raw) return this._стеклоДиффа();

    // Эта деталь оказалась хуже всех прежних — значит шкала всей модели растянулась, и
    // посчитанное до неё покрашено по СТАРОМУ пределу. Перекрасим их, когда очередь
    // кончится: сейчас предел ещё может вырасти снова.
    const tex = this._diffColor(raw);
    if (!tex) return this._стеклоДиффа();
    this._diffCache.set(ключ, { raw, tex });
    return this._картой(tex, Viewer._откудаРазмещение(родной));
  }


  /**
   * Схожесть структуры у САМОЙ пострадавшей детали: 1 — цела, 0 — не осталось ничего.
   * `null` — сравнивать было нечего.
   *
   * Отдельное число рядом с картинкой, потому что цвет отвечает на вопрос «где», а этот —
   * на «насколько». Взято SSIM, а не наша шкала: это общепринятая мера, её значение
   * понятно без пояснений и не зависит от того, где мы поставили порог красного.
   */
  diffScale(): number | null {
    if (!this._diffCache.size) return null;
    let худшая = 1;
    for (const я of this._diffCache.values()) if (я.raw.ssim < худшая) худшая = я.raw.ssim;
    return худшая;
  }

  /**
   * Материал с готовой картой различий — И С ТЕМ ЖЕ РАЗМЕЩЕНИЕМ, что у исходной текстуры.
   *
   * ДЕФЕКТ, найденный Александром 2026-09-04: «на многих моделях видны потяжки… в одном
   * месте просто пиксели, в другом растяжка, будто там текстура была наложена линиями».
   * И там же: у `SheenWoodLeather` самая красная часть на глаз сломана меньше всего, а у
   * `AnimationPointerUVs` «не отыгрывается анимация на текстуре и части текстур вообще не
   * работают».
   *
   * Причина у всех трёх одна. Текстура ложится на модель не «один к одному»: у неё бывает
   * сдвиг, масштаб и поворот (`KHR_texture_transform`) и свой НОМЕР НАБОРА развёртки. Замер
   * по корпусу (`_work/uv-transforms.mjs`): трансформ есть у `Calculator`, `CarConcept`,
   * `ChronographWatch`, `ConstructionSite`, `AnimationPointerUVs`; наборов развёртки у
   * `Dirty Cube` шесть, у `MosquitoInAmber` три.
   *
   * А карта различий вешалась с настройками ПО УМОЛЧАНИЮ — без сдвига, без масштаба, всегда
   * на первый набор. Отсюда растяжки, красное не на том месте и мёртвая анимация: она
   * двигает исходную текстуру, а наша лежала неподвижно.
   *
   * Размещение берём у ТОЙ САМОЙ текстуры, что лежит на модели сейчас, и запоминаем её:
   * анимация меняет сдвиг каждый кадр, и одного копирования при создании мало (см.
   * `_догнатьРазмещение`).
   */
  _картой(map: THREE.CanvasTexture, источник?: THREE.Texture | null) {
    let карта = map;
    if (источник) {
      // ОДНА КАРТА — ОДИН ХОЗЯИН РАЗМЕЩЕНИЯ.
      //
      // Готовая карта различий общая для всех материалов с тем же содержимым, а размещение
      // переносится НА НЕЁ. Пока хозяин один — всё честно. Если второй материал кладёт те же
      // карты иначе, ему выдаётся СВОЯ копия: она делит картинку (память не растёт вдвое),
      // но держит собственные сдвиг, масштаб и набор развёртки.
      //
      // Копии живут при самой карте и переиспользуются: иначе каждое повторное применение
      // режима плодило бы новые текстуры на видеокарте.
      const хозяин = map.userData.хозяинРазмещения as THREE.Texture | undefined;
      if (хозяин && хозяин !== источник) {
        const копии = (map.userData.копии ||= new Map<string, THREE.Texture>()) as Map<string, THREE.Texture>;
        let своя = копии.get(источник.uuid);
        if (!своя) {
          своя = map.clone();
          копии.set(источник.uuid, своя);
        }
        карта = своя as THREE.CanvasTexture;
      } else {
        map.userData.хозяинРазмещения = источник;
      }
      Viewer._перенестиРазмещение(источник, карта);
    }
    const m = new THREE.MeshBasicMaterial({ map: карта, side: THREE.DoubleSide, toneMapped: false });
    if (источник) m.userData.источникРазмещения = источник;
    return m;
  }

  /**
   * У какой текстуры брать размещение. Базовый цвет, если он есть, — он главный; иначе
   * первая попавшаяся карта материала.
   */
  static _откудаРазмещение(источник: THREE.Material | SlotMaps | null): THREE.Texture | null {
    // Принимает и материал, и готовый набор карт: у них одни и те же имена слотов, а нужен
    // ответ на один вопрос — «по какой текстуре класть».
    const m = источник as Record<string, THREE.Texture | null | undefined> | null;
    if (!m) return null;
    if (m.map) return m.map;
    for (const k of Viewer.DIFF_SLOTS) {
      if (m[k]) return m[k]!;
    }
    return null;
  }

  /** Скопировать размещение текстуры: сдвиг, масштаб, поворот, обёртку и номер набора. */
  static _перенестиРазмещение(из: THREE.Texture, в: THREE.Texture) {
    в.offset.copy(из.offset);
    в.repeat.copy(из.repeat);
    в.center.copy(из.center);
    в.rotation = из.rotation;
    в.wrapS = из.wrapS;
    в.wrapT = из.wrapT;
    // Номер набора развёртки. У модели их бывает до шести, и карта, повешенная на первый
    // вместо третьего, показывает правду не в том месте — это хуже, чем не показывать.
    в.channel = из.channel;
    в.matrixAutoUpdate = true;
  }

  /**
   * Догнать размещение, если оно поехало: анимация двигает сдвиг текстуры каждый кадр.
   *
   * `AnimationPointerUVs` — ровно такой случай: `KHR_animation_pointer` анимирует сдвиг
   * развёртки. Наша карта — отдельный объект, и без этой строки она стояла на месте, пока
   * модель под ней ехала. Стоит это нескольких присваиваний на материал за кадр.
   */
  _догнатьРазмещение() {
    for (const m of this._densityMats) {
      const из = (m as THREE.Material).userData?.источникРазмещения as THREE.Texture | undefined;
      const карта = (m as THREE.MeshBasicMaterial).map;
      if (!из || !карта) continue;
      if (карта.offset.equals(из.offset) && карта.repeat.equals(из.repeat)
        && карта.rotation === из.rotation && карта.center.equals(из.center)) continue;
      Viewer._перенестиРазмещение(из, карта);
    }
  }

  /**
   * Деталь, о которой режиму сказать НЕЧЕГО, — почти прозрачное стекло.
   *
   * Слово Александра 2026-09-01: «на машине есть стекло, оно идёт материалом, там без
   * разницы на текстуры… сделать их очень прозрачными, как стекло, но без зелёного цвета».
   *
   * Он прав по сути: зелёный означает «сравнили и отклонений нет», а у детали без карт
   * сравнивать было НЕЧЕГО. Красить её зелёным — выдавать отсутствие вопроса за
   * положительный ответ. То же и у детали, которой не нашлось пары после сборки.
   *
   * Не прячем совсем, а гасим: убранная деталь оставила бы дыру, и человек искал бы, куда
   * она делась. Сквозь погашенную видно то, ради чего режим и включали.
   */
  _стеклоДиффа() {
    return new THREE.MeshBasicMaterial({
      color: 0x9aa4ad, side: THREE.DoubleSide, toneMapped: false,
      transparent: true, opacity: 0.12, depthWrite: false,
    });
  }

  /**
   * Карты этой модели по порядку обхода — то, что обвязка передаёт второму окну.
   *
   * Пустые наборы (деталь без единой карты) сохраняются намеренно: номер детали и есть
   * ключ сопоставления, и сжать список значило бы сдвинуть все следующие пары.
   */
  /**
   * Материал детали КАК В ФАЙЛЕ, а не как сейчас на экране.
   *
   * ЕДИНСТВЕННОЕ место, где на этот вопрос отвечают, и это не про краткость. Ответ уже
   * дважды понадобился в разных местах, и дважды на нём ошиблись одинаково:
   *
   *   2026-09-01, первый раз — `_texdiffFor` читал `o.material` и при переходе «сетка →
   *   различия» получал материал ПОДСВЕТКИ, в котором ни карт, ни цвета автора. Александр:
   *   «на 0 процентах сжатия вебп ABeautifulGame вся зелёная».
   *
   *   2026-09-01, второй раз — `textureRefs()` собирал ЭТАЛОН тем же способом, и та же
   *   беда пришла с другой стороны: левое окно в режиме сетки отдавало пустые слоты, и
   *   сравнивать оказывалось не с чем. Александр: «на машине при 0 компрессии вебп почти
   *   всё зелёное».
   *
   * Третьего раза не будет: спрашивать надо здесь.
   */
  _родной(mesh: THREE.Mesh): THREE.MeshStandardMaterial | undefined {
    const сохранён = this._origMaterials.get(mesh) ?? mesh.material;
    const first = Array.isArray(сохранён) ? сохранён[0] : сохранён;
    return first as THREE.MeshStandardMaterial | undefined;
  }

  textureRefs(): DiffRef[] {
    const out: DiffRef[] = [];
    if (!this.model) return out;
    const виденные = new Set<THREE.Material>();
    this.model.traverse((o: MaybeMesh) => {
      if (!o.isMesh || !o.material) return;
      const m = this._родной(o as unknown as THREE.Mesh);
      if (!m || виденные.has(m)) return;   // один материал — одна запись, сколько бы деталей его ни носило
      виденные.add(m);
      const карты: SlotMaps = {};
      for (const k of Viewer.DIFF_SLOTS) карты[k] = (m[k] as THREE.Texture | null) || null;
      out.push({ имя: m.name || '', карты });
    });
    return out;
  }


  /**
   * Разброс плотностей ЭТОЙ модели: `[самая редкая, самая плотная]`. Обвязка спрашивает у
   * обоих окон и объединяет — иначе каждое красит по своему разбросу, и одинаковые по сути
   * детали выходят разного цвета.
   */
  densityRange(): [number, number] | null {
    if (!this.model) return null;
    let min = Infinity;
    let max = 0;
    this.model.traverse((o: MaybeMesh) => {
      if (!o.isMesh) return;
      const v = this._densityOf(o as unknown as THREE.Mesh);
      if (v > 0) { min = Math.min(min, v); max = Math.max(max, v); }
    });
    return Number.isFinite(min) && max > 0 ? [min, max] : null;
  }

  /** Общая шкала от обвязки. `null` — считать по себе. */
  setDensityScale(range: [number, number] | null) {
    this._densityScale = range;
    if (this._display === 'wire') this._applyDisplayMaterial();
  }

  /**
   * Взять память готовых карт снаружи. Обвязка держит её по парам моделей и подсовывает ту,
   * что относится к показанной сейчас паре.
   */
  useDiffStore(store: Map<string, { raw: DiffRaw; tex: THREE.CanvasTexture }>) {
    this._diffCache = store;
  }

  
  /** Эталон для режима различий. `null` — окно само является эталоном. */
  setDiffReference(refs: DiffRef[] | null) {
    // ТОТ ЖЕ ЭТАЛОН — НИЧЕГО НЕ ТРОГАЕМ. Это и есть память между входами в режим.
    //
    // Александр 2026-09-01: «выхожу из 4 режима в 3 и обратно, и опять очень долго
    // грузится… чтобы обновление было только после билда новой оптимизации и не более
    // того». Он прав, и память была заведена сразу — но не работала: обвязка зовёт этот
    // метод при КАЖДОМ применении режима, а он безусловно чистил всё посчитанное.
    //
    // Сравниваем по ССЫЛКЕ, и этого достаточно: обвязка держит один и тот же массив, пока
    // не сменилась модель (`_diffRefs` в `ui/viewer/index.ts`), а сборка новой
    // оптимизации проходит через `loadOptimized`, где он и обнуляется. То есть «после
    // билда, и не более того» — ровно как он просит.
    if (refs === this._diffRef) {
      if (this._display === 'texdiff') this._applyDisplayMaterial();
      return;
    }
    // ПАМЯТЬ ЗДЕСЬ НЕ ТРОГАЕМ ВОВСЕ, и это важно.
    //
    // Она принадлежит обвязке и разложена по ПАРАМ моделей: окно получает ту карту, что
    // относится к показанной сейчас паре (`useDiffStore`). Очистка на смене эталона
    // выбросила бы посчитанное для ПРЕЖНЕЙ пары — то есть ровно то, ради чего память и
    // заводилась («не хочу, чтобы там всё грузилось 10 часов»).
    //
    // Свежесть обеспечивает ключ пары: пересборка даёт новый адрес результата, обвязка
    // заводит под него новую карту, и пересчёт происходит сам собой.
    this._diffRef = refs;
    // Разбор по именам делается ОДИН раз на смену эталона, а не на каждую деталь: иначе
    // обход стал бы квадратичным по числу деталей.
    //
    // Одинаковые имена — не выдумка: экспортёры зовут части «Cube» по десять раз. Поэтому
    // под именем лежит ОЧЕРЕДЬ, и одноимённые разбираются по порядку встречи. Это
    // возвращает старое поведение ровно там, где имена не различают, и нигде больше.
    this._diffByName = null;
    if (refs) {
      const по = new Map<string, SlotMaps[]>();
      for (const r of refs) {
        if (!r.имя) continue;
        const список = по.get(r.имя);
        if (список) список.push(r.карты);
        else по.set(r.имя, [r.карты]);
      }
      this._diffByName = по;
    }
    if (this._display === 'texdiff') this._applyDisplayMaterial();
  }

  /**
   * Ключ памяти — ПАРА ТЕКСТУР, а не деталь.
   *
   * Деталей у `ABeautifulGame` 49, а базовых карт всего две: все белые фигуры лежат на
   * одной, все чёрные на другой. Память по детали заставляла считать одно и то же
   * сравнение 49 раз — отсюда «прям долго и тяжело идёт». По паре текстур та же модель
   * считается дважды.
   *
   * Пустой ключ означает «сравнивать нечего»: ни одной карты ни там, ни тут.
   */
  static _ключПары(эталон: SlotMaps, ставшие: SlotMaps): string {
    const части: string[] = [];
    for (const k of Viewer.DIFF_SLOTS) {
      const a = эталон[k];
      const b = ставшие[k];
      if (!a && !b) continue;
      части.push(`${k}:${a?.uuid || '—'}>${b?.uuid || '—'}`);
    }
    // РАЗМЕЩЕНИЕ В КЛЮЧ НЕ ВХОДИТ, и это важно.
    //
    // Первая редакция его добавляла — из верного опасения: одни и те же карты два материала
    // могут класть по-разному, а готовая карта у них общая. Но у АНИМИРОВАННОЙ текстуры
    // сдвиг меняется каждый кадр, и ключ вместе с ним: на `AnimationPointerUVs` каждый вход
    // в режим пересчитывал всю модель заново, а память копила мёртвые записи. Александр
    // 2026-09-04: «с анимированными текстурами всё очень плохо».
    //
    // Ключ отвечает на вопрос «то же ли СОДЕРЖИМОЕ», и размещению в нём места нет: оно не
    // меняет ни одного пикселя карты. Спор двух материалов за общую карту решается там же,
    // где и возник, — своей копией на второго (см. `_картой`).
    return части.join('|');
  }

  /**
   * Ответ, который известен БЕЗ расчёта. `null` — надо считать.
   *
   * Два случая, и оба разбираются мгновенно: детали, которой в паре не нашлось (зелёный —
   * молчим, а не показываем чужую разницу), и детали без единой карты у обеих сторон
   * (погашенное стекло — сравнивать нечего). Гнать их через очередь значило бы заставлять
   * человека ждать ответа, который есть сразу.
   */
  /**
   * Ответ, известный БЕЗ расчёта. `null` — считать всё-таки придётся.
   *
   * Три таких ответа, и каждый честнее пустого ожидания:
   *   - эталона нет вовсе (левое окно, или пары ещё нет) — сравнивать не с чем;
   *   - у детали нет пары по имени — сборка её переставила, склеила или переименовала;
   *   - ни одной карты ни у эталона, ни у результата.
   *
   * ВО ВСЕХ ТРЁХ — СТЕКЛО, А НЕ ЗЕЛЁНЫЙ. Прежняя редакция красила первые два зелёным, и
   * это было прямой ложью: зелёный читается как «сравнили, всё цело». Именно так и вышло
   * у Александра 2026-09-03: «почти всё зелёным показано на модели, где почти все текстуры
   * стали сильно сломанными». Молчание должно выглядеть молчанием.
   */
  _texdiffБыстро(родной: THREE.Material | null, эталон: SlotMaps | null): THREE.MeshBasicMaterial | null {
    if (!эталон) return this._стеклоДиффа();
    const пуст = (m: THREE.Material | null | undefined) => {
      const мат = m as THREE.MeshStandardMaterial | null | undefined;
      return !Viewer.DIFF_SLOTS.some((k) => !!мат?.[k]);
    };
    const эталонПуст = !Viewer.DIFF_SLOTS.some((k) => !!эталон[k]);
    if (эталонПуст && пуст(родной)) return this._стеклоДиффа();
    return null;
  }

  /**
   * Эталон ЭТОЙ детали — по имени, а не по месту в обходе.
   *
   * Одноимённые разбираются по порядку встречи: очередь под именем расходуется слева
   * направо, и вторая «Cube» получает вторую «Cube».
   */
  /**
   * Как сопоставлять детали ЭТОЙ модели с эталоном. Возвращает функцию на одну деталь.
   *
   * ДВА ПУТИ, и выбор между ними делается ОДИН раз на модель, а не на деталь:
   *
   *   ПО ИМЕНИ — основной. Сборка переставляет детали (замер на `ABeautifulGame`: 43
   *   расхождения из 49), поэтому место в обходе о детали не говорит ничего, а имя говорит.
   *   Одноимённые разбираются по порядку встречи: вторая «Cube» получает вторую «Cube».
   *
   *   ПО ПОРЯДКУ — запасной, и включается ровно в одном случае: НИ ОДНА деталь модели не
   *   нашлась по имени. Так бывает, когда имён нет вовсе (часть экспортёров их не пишет)
   *   или когда сборка переименовала всё. Тогда порядок — единственное, чем детали
   *   различимы; он ненадёжен, но погасить всю модель молчанием хуже.
   *
   * Смешивать пути нельзя: «не нашлось по имени — возьму следующую по порядку» сдвигает
   * все последующие пары и даёт ту самую чужую разницу, ради ухода от которой всё и
   * переписано.
   */
  _сопоставитель(): (o: THREE.Mesh) => SlotMaps | null {
    const refs = this._diffRef;
    const по = this._diffByName;
    if (!refs || !refs.length || !по) return () => null;

    // Сколько материалов модели нашлось по имени. Считается ДО обхода, один раз.
    let попаданий = 0;
    const свои = new Set<THREE.Material>();
    if (this.model) {
      this.model.traverse((o: MaybeMesh) => {
        if (!o.isMesh) return;
        const m = this._родной(o as unknown as THREE.Mesh);
        if (!m || свои.has(m)) return;
        свои.add(m);
        if (m.name && по.has(m.name)) попаданий++;
      });
    }

    // ЗАПАСНОЙ ПУТЬ — по порядку материалов, и включается только если по именам не нашлось
    // НИЧЕГО (имён нет вовсе либо сборка переименовала всё). Смешивать пути нельзя: «не
    // нашлось по имени — возьму следующий по порядку» сдвигает все последующие пары.
    const выдано = new Map<THREE.Material, SlotMaps | null>();
    if (попаданий === 0) {
      let i = 0;
      return (mesh: THREE.Mesh) => {
        const m = this._родной(mesh);
        if (!m) return null;
        if (!выдано.has(m)) выдано.set(m, refs[i++]?.карты || null);
        return выдано.get(m) || null;
      };
    }
    const взято = new Map<string, number>();
    return (mesh: THREE.Mesh) => {
      const m = this._родной(mesh);
      if (!m) return null;
      // Один материал — один ответ: детали, носящие его, обязаны выглядеть одинаково,
      // а очередь одноимённых не должна расходоваться на каждую из них.
      if (выдано.has(m)) return выдано.get(m) || null;
      const имя = m.name;
      let ответ: SlotMaps | null = null;
      if (имя) {
        const список = по.get(имя);
        if (список) {
          const n = взято.get(имя) || 0;
          взято.set(имя, n + 1);
          ответ = список[n] || null;
        }
      }
      выдано.set(m, ответ);
      return ответ;
    };
  }

  /**
   * Заглушка на время расчёта: деталь видна, но её карта ещё не посчитана.
   *
   * Не прозрачная и не красная — НЕЙТРАЛЬНАЯ. Красная соврала бы про потери, зелёная — про
   * их отсутствие, а ответа пока нет ни того ни другого. Серое читается как «здесь ещё
   * считают», и через долю секунды сменится настоящим цветом.
   */
  _заглушкаДиффа() {
    return new THREE.MeshBasicMaterial({
      color: 0x5b6672, side: THREE.DoubleSide, toneMapped: false,
    });
  }

  /**
   * Очередь тяжёлых расчётов: по одной детали за кадр.
   *
   * ПОЧЕМУ ПО ОДНОЙ, А НЕ ПАЧКОЙ. Одна деталь с картой 2048×2048 — это шесть проходов по
   * четырём миллионам пикселей. Две за кадр уже дают заметный рывок, и приложение снова
   * выглядит залипшим — а ради того, чтобы оно не выглядело залипшим, всё и затевалось.
   *
   * Модель при этом ВИДНА с первого кадра: обход расставил заглушки, и деталь за деталью
   * они сменяются настоящими картами. Человек видит, что работа идёт, без единой цифры.
   */
  _runDiffQueue() {
    // Проверка на ИСТИННОСТЬ, а не на `!== null`.
    //
    // Поле объявлено через `declare` и до первого запуска равно `undefined`, а не `null`.
    // Сравнение с `null` давало «уже идёт» на самом первом вызове, и очередь не
    // запускалась НИ РАЗУ — ни в прогоне, ни в программе. Поймано тестами: они честно
    // ждали окончания работы, которая не начиналась.
    if (this._diffTimer) return;               // уже идёт
    if (!this._diffQueue.length) return;
    this._onBusy?.(true);
    const шаг = () => {
      // Режим сменили посреди работы — бросаем: считать уже не для чего.
      if (this._display !== 'texdiff') {
        this._diffQueue.length = 0;
        this._diffTimer = null;
        this._onBusy?.(false);
        return;
      }
      // БЮДЖЕТ НА КАДР, а не «одна деталь за кадр».
      //
      // Одна за кадр — это 60 деталей в секунду при любой их сложности: на шахматах (49
      // деталей) почти секунда, на модели в пятьсот частей — восемь. При этом почти все
      // они берутся из памяти по паре текстур и считаются мгновенно, то есть кадр простаивал.
      //
      // Восемь миллисекунд — половина кадра шестидесятигерцового монитора. Остаток кадра
      // остаётся окну на отрисовку, поэтому оно не замирает; проверка бюджета стоит ПОСЛЕ
      // первого дела, чтобы за кадр делалось хотя бы одно даже на самой тяжёлой карте.
      const начало = performance.now();
      do {
        const дело = this._diffQueue.shift();
        if (!дело) break;
        const m = this._texdiffFor(дело.родной, дело.эталон, дело.ключ);
        this._densityMats.add(m);
        дело.mesh.material = m;
      } while (this._diffQueue.length && performance.now() - начало < 8);
      if (this._diffQueue.length) {
        this._diffTimer = requestAnimationFrame(шаг);
      } else {
        this._diffTimer = null;
        // Снятые пиксели больше не нужны: готовые карты лежат в памяти различий, а сырые
        // занимали бы десятки мегабайт до конца жизни окна.
        this._пиксели?.clear();
        this._onBusy?.(false);
      }
    };
    this._diffTimer = requestAnimationFrame(шаг);
  }

  /** Кому сообщать, что идёт долгая работа. Ставит обвязка. */
  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this._onBusy = typeof fn === 'function' ? fn : null;
  }

  /** Освободить материалы подсветки: они свои у каждой детали и живут только в режиме. */
  _dropDensityMaterials() {
    for (const m of this._densityMats) m.dispose();
    this._densityMats.clear();
  }

  /**
   * Сетка — рёбра, ПОКРАШЕННЫЕ ПО ПЛОТНОСТИ. Материал свой у каждой детали.
   *
   * Раньше здесь был ОДИН серый материал на всю модель: у ребра нет ни лицевой стороны, ни
   * цвета из файла, и общего материала хватало. С 2026-09-01 цвет несёт смысл, поэтому
   * общим он быть перестал.
   *
   * Слово Александра: «просто смотреть на сетку нет никакого смысла». Голая сетка
   * показывала ту же плотность — только читать её приходилось по густоте штрихов; цвет
   * отвечает прямо, а рёбра остаются на месте.
   *
   * `DoubleSide` — чтобы задние рёбра были видны, как в Blender; без него половина
   * каркаса пропадает и смотреть становится не на что.
   */
  _wireMaterial(mesh: THREE.Mesh, min: number, max: number) {
    const m = this._densityFor(mesh, min, max);
    m.wireframe = true;
    return m;
  }

  /**
   * Глина для одной детали — с ЦВЕТОМ АВТОРА, если он его задал.
   *
   * ДЕФЕКТ, найденный Александром 2026-08-22 на его же модели `gluke-purple.glb`:
   * «с моей модели на которой был 1 цвет (фиолетовый) спал полностью этот цвет. цвета и
   * материалы которые встроены в модель без текстур не должны сами собой пропадать
   * и/или заменяться на глину».
   *
   * Он прав, и ошибка была в самой посылке. Глина заводилась под мысль «нет текстур —
   * значит и цвета нет, экспортёр оставил белое по умолчанию». У его модели текстур нет,
   * а цвет есть: `baseColorFactor` фиолетовый, шероховатость 0,55, металличность 0,05.
   * Всё это автор задал руками — и мы стирали его работу, не спросив.
   *
   * Починка не «отключить глину», а перестать ею ЗАМЕЩАТЬ. `MeshMatcapMaterial.color`
   * умножается на картинку шара: глина даёт форму, цвет остаётся авторский. У модели, где
   * цвета и правда нет, множитель — белый, то есть глина выходит ровно прежней.
   *
   * Чего маткап показать не может — шероховатость и металличность: у него нет таких
   * величин вовсе. Это цена режима показа, а не потеря: в файле они целы, и «Материалы из
   * файла» возвращает их одним переключением.
   */
  _clayFor(side: THREE.Side, source?: THREE.Material | null) {
    const tint = (source as THREE.MeshStandardMaterial | undefined)?.color;
    const hex = tint ? tint.getHex() : 0xffffff;
    const key = `${side}:${hex}`;
    let mat = this._clay.get(key);
    if (!mat) {
      // Картинка шара одна на все материалы: она не зависит ни от чего, кроме себя.
      if (!this._clayMap) this._clayMap = makeClayMatcap();
      mat = new THREE.MeshMatcapMaterial({ matcap: this._clayMap, side, color: hex });
      this._clay.set(key, mat);
    }
    return mat;
  }

  /**
   * Затемнение по глубине — вторая половина ответа на «плоские детали не видно».
   *
   * Тональные ступени в самой глине разводят грани, повёрнутые по-разному. Но две
   * ПАРАЛЛЕЛЬНЫЕ пластины, одна за другой, повёрнуты одинаково — значит и тон у них
   * одинаковый, и сливаются они намертво. Различить их может только расстояние до
   * камеры, и вот оно.
   *
   * Границы считаются от габарита модели и текущего положения камеры, а не задаются
   * числом: у одной модели десять сантиметров, у другой сто метров, и постоянная
   * величина означала бы «на одной ничего не видно, вторая утонула целиком».
   *
   * Цвет — тень самой глины, а не фон. Дальнее должно ТЕМНЕТЬ, а не растворяться:
   * растворившаяся деталь пропадает вместе со своим силуэтом, и лечение вышло бы хуже
   * болезни.
   *
   * В режиме «Материалы из файла» тумана нет вовсе: там показывается модель, какая она
   * есть, и подкрашивать её нельзя.
   */
  _updateClayDepth() {
    if (this._display !== 'clay' || !this.model) {
      this.scene.fog = null;
      return;
    }
    if (!this._clayBounds) {
      const box = new THREE.Box3().setFromObject(this.model);
      if (box.isEmpty()) { this.scene.fog = null; return; }
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this._clayBounds = { center: sphere.center.clone(), radius: sphere.radius || 1 };
    }
    const { center, radius } = this._clayBounds;
    const dist = this._activeCamera().position.distanceTo(center);
    if (!this.scene.fog) this.scene.fog = new THREE.Fog(0x2b2926, 1, 2);
    const fog = this.scene.fog as THREE.Fog;
    // Ближняя граница — передний край модели, дальняя — чуть за задним. Затемнение
    // ложится ровно на её глубину и не зависит от того, насколько человек отъехал.
    fog.near = Math.max(0.01, dist - radius * 0.85);
    fog.far = dist + radius * 1.15;
  }

  /**
   * Досчитать нормали тем частям, у которых их нет, — ТОЛЬКО ради показа.
   *
   * ЗАЧЕМ. Глина — это маткап: оттенок берётся по направлению, в которое смотрит
   * поверхность. Нет нормалей — брать не по чему, и деталь заливается одним цветом. Со
   * стороны это выглядит как «оптимизация расплющила модель».
   *
   * ОТКУДА БЕРУТСЯ БЕЗНОРМАЛЬНЫЕ МОДЕЛИ. Замер 2026-08-28 по шести текстурным моделям:
   * четыре доезжают с нормалями, а `chibi_zenitsu` и `parkergirl` их теряют — у обеих
   * материал `unlit`, «не освещать», и чистка справедливо убирает атрибут, которого не
   * касается ни один материал (12 байт на вершину). НА САЙТЕ модель при этом выглядит
   * ровно как прежде: unlit и раньше на нормали не смотрел.
   *
   * И вот это было нашей бедой: окно сравнения показывало разницу, которой в продукте
   * НЕТ. Александр, 2026-08-28: «в одном (исходном) модель выглядит нормально и с
   * глубиной, а во втором (уже оптимизированная) — очень плоско».
   *
   * ГРАНИЦА (Правило 11). Считаем в СЦЕНЕ ПОКАЗА и только для глины. В файл не попадает
   * ни байта: собранная модель уезжает без нормалей, как и решила чистка. Это ровно то
   * же, что подмена материала на глину, — способ ПОСМОТРЕТЬ, а не правка модели.
   *
   * Считается один раз на геометрию: `computeVertexNormals()` заводит атрибут, и второй
   * заход его уже видит.
   */
  _ensureClayNormals() {
    if (!this.model) return;
    const мои = this._clayNormals ?? (this._clayNormals = new Set<THREE.BufferGeometry>());
    this.model.traverse((o: MaybeMesh) => {
      if (!o.isMesh) return;
      const geometry = (o as unknown as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!geometry?.attributes || geometry.attributes['normal']) return;
      if (!geometry.attributes['position']) return;
      geometry.computeVertexNormals();
      мои.add(geometry);
    });
  }

  /**
   * Снять нормали, которые досчитала ГЛИНА, — при выходе из неё.
   *
   * Без этого «материалы из файла» переставали значить «как в файле»: у модели без
   * нормалей и с обычным (не unlit) материалом three.js затеняет по граням, а после
   * захода в глину — гладко. Один и тот же режим показывал разное в зависимости от того,
   * куда человек заглядывал до этого.
   *
   * Снимаем ТОЛЬКО своё: множество помнит те геометрии, которым атрибут добавили мы.
   * Родные нормали модели не трогаются никогда.
   */
  _dropClayNormals() {
    const мои = this._clayNormals;
    if (!мои?.size) return;
    for (const geometry of мои) geometry.deleteAttribute('normal');
    мои.clear();
  }

  _applyDisplayMaterial() {
    if (!this.model) return;
    // Глина и сетка проходят одним путём НЕ ради краткости: сохранение и возврат родных
    // материалов обязаны быть общими. Разведи их по двум веткам — и вторая когда-нибудь
    // забудет вернуть, а «Правило 11» проверяется именно тем, что модель уезжает такой,
    // какой пришла.
    // Нормали нужны ГЛИНЕ и только ей: сетка рисует рёбра, а родные материалы модели —
    // дело самой модели, и досчитывать за неё там нечего. Вышли из глины — своё убрали.
    if (this._display === 'clay') this._ensureClayNormals();
    else this._dropClayNormals();
    // Материалы, СДЕЛАННЫЕ ЭТИМ ЖЕ ПРОХОДОМ, освобождаются в начале следующего — без
    // перечисления режимов поимённо.
    //
    // Замечание Александра 2026-09-01: «если у нас появятся новые варианты рендера, это
    // тоже не должно сбрасываться… не должно быть хардкода, который бы относил работу
    // 4 окна вообще к какому-либо другому варианту рендера». Здесь стоял список
    // `!== 'wire' && !== 'texdiff'` — пятый режим пришлось бы дописывать сюда, и забытая
    // строка молча освобождала бы чужие материалы прямо во время показа.
    //
    // ПАМЯТЬ РАЗЛИЧИЙ этим не затрагивается вовсе: она живёт в обвязке, разложена по парам
    // моделей и от режима не зависит ни в какую сторону.
    this._dropDensityMaterials();
    // Очередь расчёта СТРОИТСЯ ЗАНОВО при каждом применении режима, поэтому старую надо
    // снять. Иначе в ней остаются дела от ПРЕЖНЕЙ модели: они указывают на меши, которых
    // в сцене больше нет, и их карты легли бы поверх новой модели. Поймано собственным
    // тестом «деталь, ответ по которой известен сразу, в очередь не идёт»: он увидел в
    // очереди два чужих дела.
    this._diffQueue.length = 0;
    if (this._display !== 'file') {
      // Границы шкалы плотности считаются ОДИН раз на всю модель и до обхода: цвет каждой
      // детали зависит от того, какая в этой модели самая плотная и какая самая редкая.
      let min = Infinity;
      let max = 0;
      // Способ сопоставления выбирается ОДИН раз на модель — см. `_сопоставитель`.
      const эталонДля = this._display === 'texdiff' ? this._сопоставитель() : null;
      if (this._display === 'wire') {
        // ШКАЛА ОБЩАЯ НА ОБА ОКНА, если обвязка её задала.
        //
        // ДЕФЕКТ, найденный Александром 2026-09-01: «на кар концепт теперь всё выглядит
        // так, будто после оптимизации стало только хуже… это напугает человека и даст ему
        // неверное понимание проблемы».
        //
        // Он был прав, и замер объяснил причину (`_work/probe-join-density.mjs`). Своя
        // шкала у каждого окна растягивается по СОБСТВЕННОМУ разбросу. У `CarConcept` до
        // склейки 97 деталей с разбросом в 4,1 порядка, после — 21 деталь с разбросом 1,7.
        // На своих шкалах красными выходили 37 из 97 слева и 14 из 21 справа: доля
        // красного росла с 38% до 67%, и правое окно читалось как «стало хуже».
        //
        // На ОБЩЕЙ шкале правда обратная: 37 из 97 против ОДНОЙ из 21. Склеенная деталь
        // покрывает больший объём тем же числом треугольников, то есть становится реже, а
        // не гуще. Своя шкала показывала не плотность, а разброс внутри модели.
        const общая = this._densityScale;
        if (общая) {
          min = общая[0];
          max = общая[1];
        } else {
          this.model.traverse((o: MaybeMesh) => {
            if (!o.isMesh) return;
            const v = this._densityOf(o as unknown as THREE.Mesh);
            if (v > 0) { min = Math.min(min, v); max = Math.max(max, v); }
          });
          if (!Number.isFinite(min)) min = 0;
        }
      }
      this.model.traverse((o: MaybeMesh) => {
        if (!o.isMesh || !o.material) return;
        const mesh = o as unknown as THREE.Mesh;
        if (!this._origMaterials.has(mesh)) this._origMaterials.set(mesh, o.material!);
        // РОДНОЙ материал берётся из сохранённого, а НЕ из `o.material`.
        //
        // Дефект, найденный Александром 2026-09-01: «на 0 процентах сжатия вебп
        // ABeautifulGame вся зелёная, она должна вся покраснеть». Причина — переход между
        // режимами БЕЗ возврата к материалам файла: сетка уже подменила материал детали, и
        // следующий режим читал у подменённого ни цвета автора, ни карты. Различия
        // сравнивались с пустотой и выходили зелёными; глина по той же причине теряла
        // авторский цвет при переходе из сетки.
        //
        // Сохранённое здесь и есть «как было в файле» — из него и берём.
        // Материал как в файле — через общего помощника: см. `_родной`, там записано,
        // почему на этот вопрос отвечают в одном месте.
        const first = this._родной(mesh);
        if (this._display === 'wire') {
          const m = this._wireMaterial(mesh, min, max);
          this._densityMats.add(m);
          o.material = m;
          return;
        }
        if (this._display === 'texdiff') {
          // СНАЧАЛА показываем деталь, ПОТОМ считаем её карту.
          //
          // Александр 2026-09-01: «загрузка в 4 окне сильно тормозит всё приложение и оно
          // выглядит залагавшим… чтобы загрузка не нагружала само приложение».
          //
          // Расчёт шести карт на деталь — секунды на модель вроде ABeautifulGame, и
          // делать его прямо здесь значит остановить всё окно до конца обхода. Поэтому
          // обход только РАССТАВЛЯЕТ материалы, а тяжёлое уходит в очередь и считается по
          // кадру за раз (`_queueDiff`). Готовое из памяти подставляется сразу — там
          // считать нечего.
          // Эталон ищется ПО ИМЕНИ детали: сборка переставляет детали, и место в обходе
          // не сохраняется (см. тип DiffRef).
          const эталон = эталонДля?.(mesh) || null;
          // Три исхода, и в очередь идёт только ТРЕТИЙ.
          //
          //   1. Карта уже посчитана — берём из памяти.
          //   2. Ответ известен без расчёта (нет пары, нет карт) — отдаём сразу:
          //      заставлять человека ждать ответа, который есть, неправильно.
          //   3. Считать надо — ставим заглушку и уходим в очередь.
          const ставшие: SlotMaps = {};
          const мат = first as THREE.MeshStandardMaterial | null;
          for (const k of Viewer.DIFF_SLOTS) ставшие[k] = (мат?.[k] as THREE.Texture | null) || null;
          const ключ = эталон ? Viewer._ключПары(эталон, ставшие) : '';
          const готовая = ключ ? this._diffCache.get(ключ) : undefined;
          const быстрый = готовая ? null : this._texdiffБыстро(first ?? null, эталон);
          const m = готовая
            ? this._картой(готовая.tex, Viewer._откудаРазмещение(first ?? null))
            : (быстрый ?? this._заглушкаДиффа());
          this._densityMats.add(m);
          o.material = m;
          if (!готовая && !быстрый && эталон) {
            this._diffQueue.push({ mesh, родной: first ?? null, эталон, ключ });
          }
          return;
        }
        o.material = this._clayFor(first ? first.side : THREE.FrontSide, first);
      });
      // Очередь набралась — запускаем её. Она сама сообщит, когда работа кончится.
      //
      // А если считать нечего — говорим об этом сразу. Иначе подпись «насколько изменилось»
      // остаётся от прежнего захода: при втором входе в режим всё берётся из памяти, работы
      // нет, сообщать некому — и человек читает вчерашнее число. Поймано на KTX2: шкала
      // 5,09%, подпись 2,67%.
      if (this._display === 'texdiff') {
        if (this._diffQueue.length) this._runDiffQueue();
        else this._onBusy?.(false);
      }
      // Затемнение по глубине — свойство ГЛИНЫ, и внутри оно само проверяет режим.
      // Сетке туман не нужен: рёбра и так разведены пустотой между ними.
      this._updateClayDepth();
      return;
    }
    for (const [mesh, mat] of this._origMaterials) mesh.material = mat;
    this._origMaterials.clear();
    this._updateClayDepth();
  }

  /**
   * Есть ли у модели хоть одна текстура. По этому вопросу обвязка решает, предлагать ли
   * глину сразу: у модели, где текстур нет вовсе, подменять нечего — родной материал не
   * несёт ни картинки, ни цвета, только белое по умолчанию.
   */
  hasTextures() {
    return !!(this.stats && this.stats.textures > 0);
  }

  /**
   * Показать формат, который glTF-загрузчик не откроет: STL, PLY, FBX, OBJ.
   *
   * Принимать формат и не уметь его ПОКАЗАТЬ нельзя (Правило 12): человек бросил файл,
   * сервер его принял и собрал, а левое окно написало бы «не удалось показать модель» —
   * то есть возможность есть на словах и нет на деле.
   *
   * Отдаём наружу ту же форму, что и загрузчик glTF: обвязка после этого места не должна
   * знать, откуда приехала модель. Анимаций, вариантов и расширений у этих форматов не
   * бывает — пустые списки здесь не заглушка, а факт о формате.
   *
   * Материал приходится создать: рисовать три.js без материала не умеет. Это решение
   * ПОКАЗА и в файл не попадает — сервер собирает модель сам и материала ей не выдумывает
   * (addons/gltf/importers.mts). Раскраску вершин включаем, только если она в файле есть,
   * иначе цвет вершин молча перекрасил бы модель в чёрный.
   */
  async _loadForeign(url: string, format: string) {
    const buf = await (await fetch(url)).arrayBuffer();

    // FBX стоит особняком от STL и PLY: те несут одну голую геометрию, а он — целую
    // сцену с иерархией, материалами и ССЫЛКАМИ на текстуры. Поэтому у него свой путь,
    // и материал мы ему не придумываем: он свой привёз.
    //
    // Текстуры находятся сами, и это не совпадение: загрузчику отдан ОБЩИЙ менеджер
    // (см. _initLoaders). Через его setURLModifier проходит каждый адрес, за которым
    // движок идёт, — тем же швом, каким `.gltf` из брошенной пачки находит своих
    // соседей. Здесь, в браузере, картинки декодируются по-настоящему: это показ, а не
    // сборка. На сервере тот же FBX читается иначе (addons/gltf/import-fbx.mts) — там
    // декодировать нечем и незачем, там нужны только имена файлов.
    if (format === 'fbx') {
      // Второй аргумент — БАЗА для относительных адресов текстур, и пустым его оставлять
      // нельзя: загрузчик попросил бы «textures/wood.png» от корня сайта, а подмена пачки
      // ловит только адреса, начинающиеся с базы модели (см. _installPack в index.ts).
      // Модель живёт blob-адресом — от него и отсчитываем.
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      const scene = new FBXLoader(this._manager).parse(buf, base);
      await this._applyNeighbourMaps(scene as unknown as THREE.Object3D, base);
      return { scene, animations: (scene as unknown as { animations?: unknown[] }).animations || [], parser: { json: {} }, userData: {} } as unknown as GLTF;
    }

    // OBJ — как FBX, только материалы лежат в СОСЕДНЕМ файле `.mtl`, и без него модель
    // приезжает белой, хотя автор её раскрасил. Читаем его тем же швом, каким `.gltf`
    // находит своих соседей: через общий менеджер и подмену адресов пачки.
    //
    // Развёртку здесь НЕ переворачиваем, в отличие от сервера. Разница не в небрежности:
    // `TextureLoader` в три.js по умолчанию переворачивает саму картинку (`flipY`), и
    // отсчёт V снизу, принятый в OBJ, сходится сам собой. `GLTFLoader` этого не делает —
    // поэтому переворот и живёт на стороне сборки (addons/gltf/import-obj.mts).
    if (format === 'obj') {
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));
      const loader = new OBJLoader(this._manager);
      const lib = /^\s*mtllib\s+(.+)$/im.exec(text);
      if (lib && lib[1]) {
        try {
          const mtlUrl = this._manager.resolveURL(base + lib[1].trim().split(/\s+/)[0]);
          const res = await fetch(mtlUrl);
          if (res.ok) {
            const creator = new MTLLoader(this._manager).setPath(base).parse(await res.text(), base);
            creator.preload();
            loader.setMaterials(creator);
          }
        } catch { /* нет .mtl рядом — у OBJ он необязателен, модель покажем без него */ }
      }
      const scene = loader.parse(text);
      return { scene, animations: [], parser: { json: {} }, userData: {} } as unknown as GLTF;
    }

    const geom = format === 'ply' ? new PLYLoader().parse(buf) : new STLLoader().parse(buf);
    // У STL нормали свои, у PLY их может не быть вовсе — тогда считаем по граням, иначе
    // модель выйдет плоско-чёрной.
    if (!geom.attributes.normal) geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.7,
      vertexColors: !!geom.attributes.color,
    });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(geom, mat));
    return { scene, animations: [], parser: { json: {} }, userData: {} } as unknown as GLTF;
  }

  /**
   * Положить на модель карты, лежащие рядом, — если своих у неё нет.
   *
   * ЗАЧЕМ ЭТО ЗДЕСЬ, а не только на сервере. Сервер подбирает те же карты при сборке
   * (addons/gltf/import-textures.mts), и результат справа приезжает с текстурами. Но
   * СЛЕВА человек всё это время видит серую модель — и с полным основанием считает, что
   * ничего не подключилось. Александр 2026-08-22: «текстуры до сих пор никак не
   * подключаются». Показ — это половина ответа, и она была пустой.
   *
   * Правила подбора те же, что на сервере, и границы те же: берёмся только когда своих
   * карт у модели нет ни одной, кладём один набор на все части, ничего не выдумываем
   * сверх имён файлов. Расхождение между тем, что видно, и тем, что соберётся, было бы
   * хуже пустого экрана.
   */
  async _applyNeighbourMaps(scene: THREE.Object3D, base: string) {
    if (!this._packFiles || !this._packFiles.length || !this._resolveAsset) return;

    // Свои карты есть — не наше дело.
    let hasMap = false;
    scene.traverse((o: MaybeMesh) => {
      if (!o.isMesh) return;
      for (const m of ([] as THREE.Material[]).concat(o.material as never)) {
        if (m && (m as THREE.MeshStandardMaterial).map) hasMap = true;
      }
    });
    if (hasMap) return;

    const find = (re: RegExp) => this._packFiles.find((p) => re.test(p.slice(p.lastIndexOf('/') + 1)));
    const wanted: Array<[string, RegExp]> = [
      ['map', /(basecolor|base_color|albedo|diffuse)/i],
      ['normalMap', /normal/i],
      ['roughnessMap', /rough/i],
      ['metalnessMap', /metal/i],
      ['aoMap', /((^|[._-])ao([._-]|$)|occlusion|ambient)/i],
      ['emissiveMap', /emissi/i],
    ];

    const loader = new THREE.TextureLoader(this._manager);
    const maps: Record<string, THREE.Texture> = {};
    for (const [slot, re] of wanted) {
      const rel = find(re);
      if (!rel) continue;
      const target = this._resolveAsset(base + rel) || base + rel;
      try {
        const tex = await loader.loadAsync(target);
        // Цвет и свечение живут в sRGB, служебные карты — в линейном. Перепутать здесь
        // значит получить выцветшую модель, и заметить это по числам будет нельзя.
        if (slot === 'map' || slot === 'emissiveMap') tex.colorSpace = THREE.SRGBColorSpace;
        maps[slot] = tex;
      } catch { /* картинка не открылась — просто не кладём её */ }
    }
    if (!Object.keys(maps).length) return;

    // МНОЖИТЕЛИ УСТУПАЮТ ТОЛЬКО СВОИМ КАРТАМ — то же правило, что на сервере, и по той
    // же причине: у three.js color, roughness и metalness тоже УМНОЖАЮТСЯ на свои карты.
    //
    // Первая редакция заводила новый материал с нуля. Это гасило чёрный базовый цвет из
    // Blender (хорошо, Александр этого и ждал) — но заодно стирало ВСЁ остальное, чего он
    // менять не просил: свою шероховатость, свой металл, своё свечение. Приложив одну
    // карту рельефа, человек терял настройки материала целиком.
    //
    // Поэтому берём материал автора и меняем в нём ровно те слоты, для которых карта
    // нашлась. Клонируем, а не правим на месте: тот же материал может стоять и на других
    // частях, которых наш набор не касается.
    const patched = new Map<THREE.Material, THREE.Material>();
    const patch = (src: THREE.Material): THREE.Material => {
      const seen = patched.get(src);
      if (seen) return seen;
      const m = (src && (src as THREE.MeshStandardMaterial).isMeshStandardMaterial
        ? (src.clone() as THREE.MeshStandardMaterial)
        : new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 1 }));
      if (maps.map) { m.map = maps.map; m.color = new THREE.Color(0xffffff); }
      if (maps.normalMap) m.normalMap = maps.normalMap;
      if (maps.roughnessMap) { m.roughnessMap = maps.roughnessMap; m.roughness = 1; }
      if (maps.metalnessMap) { m.metalnessMap = maps.metalnessMap; m.metalness = 1; }
      if (maps.aoMap) m.aoMap = maps.aoMap;
      if (maps.emissiveMap) { m.emissiveMap = maps.emissiveMap; m.emissive = new THREE.Color(0xffffff); }
      m.needsUpdate = true;
      patched.set(src, m);
      return m;
    };

    scene.traverse((o: MaybeMesh) => {
      if (!o.isMesh) return;
      // aoMap в three.js читает ВТОРУЮ развёртку. У моделей из экспорта её обычно нет —
      // тогда затенение просто не проявится, и это лучше, чем чёрная модель.
      if (maps.aoMap && o.geometry && !o.geometry.getAttribute('uv1') && o.geometry.getAttribute('uv')) {
        o.geometry.setAttribute('uv1', o.geometry.getAttribute('uv'));
      }
      o.material = Array.isArray(o.material)
        ? (o.material as THREE.Material[]).map(patch)
        : patch(o.material as THREE.Material);
    });
  }

  /** Базовая статистика загруженной модели (для HUD ещё до оптимизации). */
  getStats() {
    return this.stats || null;
  }

  /** Что уже использовано в исходнике: { draco, meshopt, ktx2 } — для авто-флажков [Source]. */
  getDetection() {
    return this.detected || null;
  }

  /** Навести камеру на модель по её bounding box (3/4-ракурс, с отступом). */
  frame() {
    if (!this.model) return;

    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.4; // небольшой отступ от краёв кадра

    const dir = new THREE.Vector3(1, 0.6, 1).normalize();
    this.camera.position.copy(center).add(dir.multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.minDistance = dist * 0.05;
    this.controls.maxDistance = dist * 20;
    this.controls.update();
  }

  // ---------------------------------------------------------------------
  // Анимация
  //
  // Проигрывание нужно не для красоты. Скиннинг и morph-таргеты — единственное,
  // что оптимизация может испортить незаметно: метрики сойдутся, валидатор
  // промолчит, а персонаж в движении сложится пополам. Увидеть это можно только
  // в движении, и лучше — сразу рядом с оригиналом.
  //
  // Время анимации хранится снаружи (dual-viewport задаёт его обоим вьюпортам
  // через setAnimationTime), а не тикает внутри каждого. Иначе два вьюпорта
  // разъезжаются по фазе за первые же секунды, и сравнивать «до и после»
  // становится невозможно — глаз ловит разницу поз, а не разницу оптимизации.
  // ---------------------------------------------------------------------

  /** Подготовить микшер под клипы загруженной модели. Клипов нет — тихо ничего. */
  _setupAnimations(clips: THREE.AnimationClip[] | undefined) {
    this._disposeMixer();
    this.clips = Array.isArray(clips) ? clips : [];
    if (!this.clips.length || !this.model) return;
    this._mixer = new THREE.AnimationMixer(this.model);
    this.playClip(0);
    // Первый кадр развёрток. Миксер свои дорожки ставит сам через setTime(0) в playClip,
    // а наш привод к нему не подключён — без этой строки текстуры до первого движения
    // ползунка стояли бы в том виде, в каком их записал экспортёр.
    if (this._uv) this._uv.apply(0);
  }

  /** Включить клип по индексу. Прежнее действие останавливается. */
  playClip(index: number) {
    if (!this._mixer || !this.clips.length) return;
    const i = Math.max(0, Math.min(index, this.clips.length - 1));
    this._mixer.stopAllAction();
    this._action = this._mixer.clipAction(this.clips[i]!);
    this._action.reset();
    this._action.play();
    this.clipIndex = i;
    // Кадр под нулевым временем — иначе до первого setAnimationTime модель
    // висит в bind pose, а это не то же самое, что первый кадр анимации.
    this._mixer.setTime(0);
  }

  /**
   * Поставить анимацию в абсолютное время (секунды от начала клипа).
   * Абсолютное, а не приращение: только так два вьюпорта гарантированно
   * показывают один и тот же момент, сколько бы кадров ни пропустил любой из них.
   */
  setAnimationTime(seconds: number) {
    // Развёртки текстур живут ВНЕ миксера (см. pointer-uv.ts) и должны идти по тому же
    // времени. Ставим их даже когда миксера нет вовсе: у модели может не остаться ни
    // одной обычной дорожки — у PotOfCoals вся анимация как раз в развёртках.
    const uvDur = this._uv ? this._uv.duration : 0;
    if (this._uv) this._uv.apply(uvDur > 0 ? seconds % uvDur : seconds);

    if (!this._mixer || !this._action) return;
    const dur = this._action.getClip().duration || 0;
    this._mixer.setTime(dur > 0 ? seconds % dur : seconds);
  }

  /**
   * Экспозиция тонмаппинга. Модели часто приходят пересвеченными — материалы
   * настраивались под другое окружение, а у нас своё студийное IBL. Это не
   * дефект модели и не дефект оптимизации, но рассмотреть в таком виде ничего
   * нельзя. Регулятор ничего не меняет в самом файле — только в показе.
   */
  setExposure(value: number) {
    const v = Number(value);
    this.renderer.toneMappingExposure = Number.isFinite(v) ? v : 1;
  }

  /**
   * Где брать соседние файлы модели. Ставится ПЕРЕД загрузкой пачки и снимается после
   * неё: подмена принадлежит одной конкретной загрузке, а не движку навсегда.
   *
   * Функция отвечает `null` на всё, что её не касается, — тогда адрес идёт как был.
   */
  /**
   * Список файлов брошенной пачки — отдельно от подмены адресов.
   *
   * Подмена отвечает на вопрос «куда сходить за ЭТИМ адресом», а здесь нужен другой:
   * «что вообще лежит рядом». Модель без материалов (FBX из экспорта `_nomat`) не
   * назовёт ни одного адреса, и по резолверу о её соседях узнать нечего.
   */
  setPackFiles(paths: string[] | null) {
    this._packFiles = Array.isArray(paths) ? paths.slice() : [];
  }

  setAssetResolver(resolve: ((url: string) => string | null) | null) {
    this._resolveAsset = typeof resolve === 'function' ? resolve : null;
  }

  // ── Варианты материала ─────────────────────────────────────────────────────
  //
  // Плагин кладёт имена в gltf.userData.variants, а переключатель — в
  // gltf.functions.selectVariant. Обе величины принадлежат КОНКРЕТНОЙ загрузке:
  // переключатель замкнут на parser этой модели и на следующей станет мусором,
  // поэтому снимается в _disposeModel вместе с моделью.
  //
  // Ни одной строки для человека здесь нет и быть не может: имена вариантов пишет
  // художник в своём редакторе, а подписи вокруг них — дело интерфейса (Правило 8).
  _readVariants(gltf: GLTF) {
    const data = gltf.userData as { variants?: unknown } | undefined;
    const fns = (gltf as unknown as { functions?: { selectVariant?: unknown } }).functions;
    const names = Array.isArray(data?.variants) ? (data!.variants as unknown[]) : [];
    this._variants = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
    this._selectVariant = typeof fns?.selectVariant === 'function'
      ? (fns.selectVariant as (o: THREE.Object3D, name: string | null) => Promise<unknown>)
      : null;
    // Начальный вид — тот, что записан в самом файле как основной, а не первый из
    // списка: экспортёр выбирает его сознательно, и подменять этот выбор нельзя.
    this._variant = null;
  }

  // ── Интерактив ─────────────────────────────────────────────────────────────
  //
  // ПОКАЗ И ИСПОЛНЕНИЕ. Обводим части, откликающиеся на нажатие, и проигрываем сам граф
  // поведения — вычислитель живёт в `interactivity-graph.ts`, связь со сценой в
  // `interactivity-runtime.ts` (ROADMAP §6д). Встретили незнакомый узел или адрес —
  // гасим интерактив ЦЕЛИКОМ и говорим об этом: половинчатое проигрывание хуже отсутствия.
  //
  // Ничего из этого В ФАЙЛ НЕ ПОПАДАЕТ (Правило 11): сдвинутый узел, погашенная видимость,
  // перекрашенный материал — состояние сцены показа, собранная модель увозит исходное.

  /**
   * Поднять исполнителя графа поведения.
   *
   * Карты «номер в файле → объект сцены» строим по разметке загрузчика
   * (`parser.associations`), а не по именам: имена повторяются, номера — нет.
   */
  _startBehaviour(gltf: {
    parser?: { json?: Record<string, unknown>; associations?: Map<unknown, { nodes?: number; materials?: number }> };
    animations?: THREE.AnimationClip[];
  }) {
    this._behaviour = null;
    const json = gltf.parser?.json as { extensions?: Record<string, unknown> } | undefined;
    const ext = json?.extensions?.['KHR_interactivity'] as { graphs?: unknown[]; graph?: number } | undefined;
    const graph = ext?.graphs?.[ext.graph ?? 0];
    if (!graph || !this.model) return;

    const assoc = gltf.parser?.associations;
    const nodes = new Map<number, THREE.Object3D>();
    const materials = new Map<number, THREE.Material>();
    if (assoc) {
      for (const [obj, at] of assoc) {
        if (at?.nodes !== undefined && (obj as THREE.Object3D).isObject3D) {
          nodes.set(at.nodes, obj as THREE.Object3D);
        }
        if (at?.materials !== undefined && (obj as THREE.Material).isMaterial) {
          materials.set(at.materials, obj as THREE.Material);
        }
      }
    }

    this._behaviourMixer = new THREE.AnimationMixer(this.model);
    this._behaviourAt = 0;
    const runtime = new InteractivityRuntime(graph, {
      nodes,
      materials,
      clips: this.clips ?? [],
      mixer: this._behaviourMixer,
      redraw: () => this.renderFrame(),
      setClickable: (at, on) => this._setClickable(at, on),
    });
    if (runtime.refusal.length) {
      // Отказ ЦЕЛИКОМ и вслух: половинчатое проигрывание хуже отсутствия. Человек
      // увидит подсветку и узнает из журнала, почему нажатия не работают.
      console.warn('KHR_interactivity: интерактив не проигрывается — не знаем: '
        + runtime.refusal.join(', '));
    }
    this._behaviour = runtime;
    runtime.start();
  }

  /**
   * Граф погасил или вернул нажимаемость узла.
   *
   * Держим ПОЛНЫЙ список отдельно от показанного: погашенная часть может вернуться, и
   * тогда её надо снова обвести. Выбросив её насовсем, мы бы этого уже не смогли.
   */
  _setClickable(nodeIndex: number, on: boolean) {
    const all = this._interactiveAll ?? [];
    if (!all.length) return;
    const off = this._interactiveOff ?? (this._interactiveOff = new Set<number>());
    if (on) off.delete(nodeIndex);
    else off.add(nodeIndex);
    this._interactive = all.filter((p) => !off.has(p.nodeIndex));
    // Обводка обязана следовать за списком: обведённая, но погашенная часть обещала бы
    // нажатие, которого автор больше не предусмотрел (Правило 12).
    if (this._interactiveMarks) this.setInteractivityMarks(true);
  }

  /**
   * Нажали в точке экрана (0..1 по обеим осям). `true` — граф откликнулся.
   *
   * Луч пускаем ТОЛЬКО по нажимаемым частям: попасть в соседнюю деталь и запустить
   * чужой отклик хуже, чем не сработать вовсе.
   */
  pickInteractive(x: number, y: number): boolean {
    const parts = this._interactive ?? [];
    if (!parts.length || !this._behaviour) return false;
    const ray = new THREE.Raycaster();
    // Камера — ТА, КОТОРОЙ НАРИСОВАН КАДР, а не орбитальная. Через камеру автора орбита
    // отключена, но нажимать человек продолжает по тому, что видит: луч из чужой точки
    // зрения либо промахивается, либо попадает по соседней детали и запускает чужой отклик.
    ray.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), this._activeCamera());
    const hits = ray.intersectObjects(parts.map((p) => p.object), true);
    if (!hits.length) return false;

    // От попавшего меша поднимаемся к той части, которая объявлена нажимаемой: у
    // многопримитивного меша попадание придётся на кусок, а номер узла — у родителя.
    for (let obj: THREE.Object3D | null = hits[0]!.object; obj; obj = obj.parent) {
      const part = parts.find((p) => p.object === obj);
      if (!part) continue;
      const responded = this._behaviour.select(part.nodeIndex);
      // Вспышка и строка в журнале — ответ на вопрос «я вообще попал?». Без него
      // тихий отклик (цвет лампы, сдвиг развёртки) неотличим от промаха.
      this._interactiveMarks?.flash(part);
      this.renderFrame();
      this.onInteractivePick?.({ name: part.name, responded });
      return responded;
    }
    return false;
  }

  /**
   * Продвинуть анимации, запущенные графом, на прошедшее время.
   *
   * РЕАЛЬНЫМ временем, а не полосой вьюпорта: граф запускает клип «сейчас», и ждать,
   * пока человек нажмёт «играть», незачем — он ведь уже нажал на деталь.
   *
   * Первый кадр после запуска даёт дельту ноль: иначе анимация прыгнула бы на всё время,
   * прошедшее с загрузки модели.
   */
  _advanceBehaviourAnimations() {
    const mixer = this._behaviourMixer;
    if (!mixer) return;
    const now = performance.now();
    const was = this._behaviourAt || 0;
    this._behaviourAt = now;
    if (!was) return;
    const dt = Math.min((now - was) / 1000, 0.1); // потолок на случай спящей вкладки
    if (dt > 0) mixer.update(dt);
  }

  /** Проигрывается ли интерактив и почему нет. */
  getBehaviourInfo() {
    return {
      playable: !!this._behaviour && !this._behaviour.refusal.length,
      refusal: this._behaviour ? [...this._behaviour.refusal] : [],
    };
  }

  /** Сколько частей откликается на нажатие и показаны ли они сейчас. */
  getInteractivityInfo() {
    const parts = this._interactive ?? [];
    return {
      count: parts.length,
      names: parts.map((p) => p.name),
      shown: !!this._interactiveMarks,
    };
  }

  /** Обвести нажимаемые части или снять обводку. false = обводить нечего. */
  setInteractivityMarks(on: boolean) {
    const parts = this._interactive ?? [];
    if (this._interactiveMarks) {
      this.scene.remove(this._interactiveMarks);
      this._interactiveMarks.dispose();
      this._interactiveMarks = null;
    }
    if (!on || !parts.length || !this.model) return false;
    const marks = new InteractivityHighlight(parts);
    // К СЦЕНЕ, а не к модели: рамка считает габарит по мировым матрицам, и вложенная в
    // модель она поехала бы вместе с её собственным преобразованием — дважды.
    this.scene.add(marks);
    this._interactiveMarks = marks;
    return true;
  }

  // ── Уровни детализации ─────────────────────────────────────────────────────
  //
  // Переключение — состояние ПОКАЗА, а не правка модели (Правило 11): спрятанный
  // уровень остаётся и в сцене, и в файле, его просто не рисуют. Ни один уровень
  // отсюда не удаляется и удалён быть не может.

  /** Какие уровни детализации есть у модели; count === 0 — их нет. */
  getLodInfo() {
    const set = this._lods;
    if (!set) return { count: 0, source: null, names: [] as string[], triangles: [] as number[], current: null };
    return {
      count: set.levels.length,
      // Откуда узнали: 'extension' — автор связал уровни как положено; 'names' и
      // 'measured' — соседние узлы, то есть ДОГАДКА (с подписью «LOD» и без неё).
      // Интерфейс обязан отличать факт от догадки: выдавать одно за другое нечестно.
      source: set.source,
      names: set.levels.map((l) => l.name),
      triangles: set.levels.map((l) => l.triangles),
      current: this._lod ?? null,
    };
  }

  /**
   * Показать уровень по номеру: 0 — самый подробный, дальше по убыванию.
   * `null` — вернуть как в файле.
   */
  setLod(index: number | null) {
    if (!this._lods || !this.model) return false;
    if (index !== null && (index < 0 || index >= this._lods.levels.length)) return false;
    showLod(this._lods, this.model, index);
    this._lod = index;
    return true;
  }

  // ---------------------------------------------------------------------
  // Камеры автора
  //
  // Ракурс — такое же решение автора, как уровни детализации и варианты материала:
  // он выбирал, откуда на модель смотреть. Загрузчик камеры читает и кладёт в
  // `gltf.cameras`, а мы до 2026-08-15 их просто не замечали и всегда ставили свою
  // орбиту. ToyCar везёт восемь ракурсов, AnimationPointerUVs — одиннадцать.
  //
  // Берём только те, что стоят В СЦЕНЕ: камера без родителя никуда не смотрит — её
  // положение задаётся узлом, и вне графа сцены оно не определено.

  /**
   * Камеры автора, добравшиеся до сцены. Имя ищем у камеры, потом у её узла.
   *
   * Берём и перспективные, и ортографические. Подменять ортографическую своей
   * перспективной — «взять место и угол, а настройки оставить наши» — нельзя: это
   * РАЗНАЯ картинка, а не разная настройка. У ортографической нет схождения линий,
   * ради него её и выбирают (чертёж, изометрия, вид сбоку). Показать вместо неё
   * перспективу значит показать не то, что делал автор, и молча.
   *
   * Стоит это ровно одной развилки в пропорциях кадра (_applyAspect): у перспективной
   * ширина задаётся полем aspect, у ортографической — границами left/right.
   */
  _readFileCameras(gltf: GLTF) {
    const cams: FileCamera[] = [];
    for (const cam of gltf.cameras || []) {
      const c = cam as FileCamera;
      const known = ('isPerspectiveCamera' in c && c.isPerspectiveCamera)
        || ('isOrthographicCamera' in c && c.isOrthographicCamera);
      if (!known) continue;
      // Камера без родителя нигде не стоит: её положение задаёт узел сцены.
      if (!c.parent) continue;
      cams.push(c);
    }
    this._fileCameras = cams;
    this._cameraIndex = null;
  }

  /** Через какую камеру смотрим и какие есть — для полки значков. */
  getCameraInfo() {
    const cams = this._fileCameras || [];
    return {
      count: cams.length,
      // Имя из файла отдаём КАК ЕСТЬ, пустое — пустым. Придумать подпись безымянной
      // камере — дело интерфейса: движок языка не знает (Правило 8), та же причина,
      // что у безымянных клипов анимации.
      //
      // Здесь лежит имя УЗЛА, а не самой камеры, и это не наша вольность: GLTFLoader
      // для узла с камерой возвращает сам объект камеры и переписывает ему имя именем
      // узла (проверено на Ortho Camera 01: в файле камеры зовутся Blueprint_Side и
      // Hero_View, а приезжают OrthoCameraNode и PerspCameraNode). Так и правильно —
      // в редакторе художник видит имя объекта, а не имя данных камеры.
      names: cams.map((c) => c.name || ''),
      current: this._cameraIndex ?? null,
    };
  }

  /**
   * Смотреть через камеру автора (номер) или вернуться к своей орбитальной (null).
   *
   * false = такой камеры в модели нет. Список приходит из файла, и интерфейс не обязан
   * гадать, что в нём окажется, — та же причина, что у setVariant.
   */
  setCamera(index: number | null) {
    const cams = this._fileCameras || [];
    if (index !== null && (index < 0 || index >= cams.length)) return false;
    this._cameraIndex = index;
    // Орбита работает только со своей камерой: авторский ракурс — это точка зрения
    // автора, а не начало для вращения. Оставь мы контролы включёнными, первое же
    // движение мыши увело бы камеру автора с её места, и вернуть её было бы нечем.
    this.controls.enabled = index === null;
    this._applyAspect();
    return true;
  }

  /** Камера, через которую рисуем прямо сейчас. */
  _activeCamera(): FileCamera {
    const cams = this._fileCameras || [];
    const i = this._cameraIndex;
    return i === null || i === undefined ? this.camera : (cams[i] || this.camera);
  }

  /**
   * Пропорции кадра под размер окна.
   *
   * Камера автора несёт СВОЁ соотношение сторон из файла, и оно почти никогда не
   * совпадает с окном программы. Держим ВЕРТИКАЛЬ авторской и подгоняем ширину — так
   * поступают все просмотрщики: по вертикали кадр остаётся авторским, по горизонтали
   * расширяется или сужается под окно. Иначе картинка растянута.
   *
   * Вертикаль у двух видов камер записана по-разному, отсюда развилка:
   *   • перспективная — угол yfov, ширина следует из поля aspect;
   *   • ортографическая — границы top/bottom, ширину задаём сами через left/right.
   */
  _applyAspect(forced?: number) {
    let ratio = forced;
    if (ratio === undefined) {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const { clientWidth, clientHeight } = parent;
      if (!clientWidth || !clientHeight) return;
      ratio = clientWidth / clientHeight;
    }
    const cam = this._activeCamera();
    if ('isOrthographicCamera' in cam && cam.isOrthographicCamera) {
      // Половина высоты — авторская, половина ширины — под окно.
      const halfH = (cam.top - cam.bottom) / 2;
      const halfW = halfH * ratio;
      cam.left = -halfW;
      cam.right = halfW;
    } else if ('isPerspectiveCamera' in cam && cam.isPerspectiveCamera) {
      cam.aspect = ratio;
    }
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------
  // Свет: наш студийный или авторский
  //
  // Модель может принести собственные источники (KHR_lights_punctual) — загрузчик
  // создаёт их сам и кладёт внутрь модели. До 2026-08-15 мы просто добавляли свой
  // направленный источник ПОВЕРХ: авторский свет никуда не девался, но оценить, как
  // модель задумана, было нельзя — светили оба.
  //
  // Гасить целиком нечего: у нас ДВА источника разной природы, и только один спорит
  // с авторским.
  //
  //   • направленный ключевой — наш, конкурент авторскому, гасится начисто;
  //   • окружение (RoomEnvironment) — это не «свет», а ТО, ЧТО ОТРАЖАЕТСЯ. Металл,
  //     стекло, лак, радужка и просвет берут картинку отсюда. Обнулив его, мы покажем
  //     не замысел автора, а чёрные пятна.
  //
  // И формат тут ни при чём: glTF окружение не описывает ВООБЩЕ. Его подставляет
  // каждый просмотрщик от себя, авторского варианта не существует — значит и «выключить
  // до авторского» нечего. Поэтому в режиме файла окружение приглушается до слабого
  // остатка (FILE_MODE_ENV наверху файла), а не до нуля: ноль был бы такой же
  // неправдой, только с другой стороны.

  /**
   * Собрать источники, которые принесла сама модель.
   *
   * Собираем СПИСОК, а не счёт. Раньше считалось только число — и переключатель мог
   * лишь узнать, есть ли авторский свет, но не погасить его: до самих источников
   * дотянуться было нечем.
   */
  _collectModelLights() {
    const found: THREE.Light[] = [];
    if (this.model) this.model.traverse((o) => { if ((o as THREE.Light).isLight) found.push(o as THREE.Light); });
    return found;
  }

  /** Есть ли у модели свой свет и чей показываем — для полки значков. */
  getLightInfo() {
    return {
      count: (this._modelLights ?? []).length,
      mode: this._lightMode ?? 'studio',
    };
  }

  /**
   * Выбрать свет: наш студийный, авторский или никакой.
   *
   * `none` — темнота НАМЕРЕННАЯ (Александр, 2026-08-28): «лайтинг стуидио\ничего. что бы
   * модель могла рендерится чёрной. или если например у текстуры есть эмишн и он
   * светится, мы же не выбираем свет встроенный в картинку. а хотелось бы его наверняка
   * увидеть». Светящаяся карта — единственное, что видно в этом режиме, и увидеть её
   * иначе нельзя: любой посторонний свет её забивает.
   *
   * Поэтому в `none` окружение гасится ДО НУЛЯ, а не до остатка, как в режиме файла.
   * Металл и стекло станут чёрными — и это ровно то, что просили: «свет вырубить».
   * Оговорка про FILE_MODE_ENV сюда не относится, там речь о чужом замысле, а здесь —
   * о прямом выборе человека (Правило 12).
   *
   * false = переключать нечего: своих источников модель не принесла, и «свет из файла»
   * означал бы ту же темноту, только необъяснённую.
   */
  setLightMode(mode: 'studio' | 'file' | 'none') {
    const own = this._modelLights ?? [];
    if (mode === 'file' && !own.length) return false;
    const studio = mode === 'studio';
    this._key.visible = studio;
    // АВТОРСКИЕ ИСТОЧНИКИ ГАСНУТ В СТУДИЙНОМ РЕЖИМЕ. Без этой строки «студийный» означал
    // наш свет ПОВЕРХ авторского — то есть ни то, ни другое, и погасить чужое солнце
    // было нечем вовсе.
    //
    // Александр, 2026-08-26, про свою модель `вулкан5.glb`: «есть модели которые очень
    // пересвечены (потому что там внутри уже стоит моё солнце)… по итогу в моём
    // приложении я не могу отключить весь свет в модели и оставить только свой».
    // Замер по файлу: два источника, `Sun` силой 683 и точечный силой 543 — поверх них
    // наш ключевой с силой 1.1 не виден вовсе, а модель белая.
    //
    // Это ПОКАЗ, а не правка: `visible` живёт в сцене просмотра и в файл не попадает.
    // Собранная модель увозит оба источника целыми (Правило 11).
    for (const l of own) l.visible = mode === 'file';
    this.scene.environmentIntensity = mode === 'studio' ? 1 : mode === 'file' ? FILE_MODE_ENV : 0;
    this._lightMode = mode;
    return true;
  }

  /** Какие варианты материала есть у модели — для панели управления. */
  getVariantInfo() {
    const names = this._variants || [];
    return { count: names.length, names: [...names], current: this._variant ?? null };
  }

  /**
   * Переключить вариант материала. `null` — вернуть исходный вид из файла.
   *
   * Возвращает true, когда переключение состоялось. Неизвестное имя — не исключение,
   * а false: список вариантов приходит из файла, и интерфейс не обязан гадать, что
   * в нём окажется.
   */
  async setVariant(name: string | null) {
    if (!this.model || !this._selectVariant) return false;
    if (name !== null && !(this._variants || []).includes(name)) return false;
    await this._selectVariant(this.model, name);
    this._variant = name;
    return true;
  }

  /** Что за анимации в модели — для панели управления. */
  getAnimationInfo() {
    if (!this.clips || !this.clips.length) return { count: 0, names: [], index: -1, duration: 0 };
    return {
      count: this.clips.length,
      // Безымянный клип отдаём ПУСТОЙ строкой, а не «Clip 3». Подпись для человека —
      // дело интерфейса: движок просмотра не знает языка и знать не должен (Правило 8).
      // Раньше здесь рождалось английское имя, которое так и висело в русском списке.
      names: this.clips.map((c) => c.name || ''),
      index: this.clipIndex ?? 0,
      duration: this.clips[this.clipIndex ?? 0]?.duration || 0,
    };
  }

  _disposeMixer() {
    if (this._mixer) {
      this._mixer.stopAllAction();
      if (this.model) this._mixer.uncacheRoot(this.model);
      this._mixer = null;
    }
    this._action = null;
    this.clips = [];
    this.clipIndex = 0;
  }

  /** Обновить контролы и отрисовать один кадр (цикл гонит dual-viewport.js). */
  renderFrame() {
    this._advanceBehaviourAnimations();
    // Рамки идут за деталями: граф двигает и гасит их прямо во время показа.
    this._interactiveMarks?.sync();
    // Через камеру автора орбита не работает: она увела бы её с места, куда автор
    // поставил. update() зовём только когда смотрим своей.
    if (this.controls.enabled) this.controls.update();
    // Затемнение считается от расстояния до камеры, а она двигается: пересчёт каждый
    // кадр — это вычитание двух чисел, дешевле любой попытки поймать момент сдвига.
    if (this._display === 'clay') this._updateClayDepth();
    // Размещение карты различий идёт за исходной текстурой: её двигает анимация.
    if (this._display === 'texdiff') this._догнатьРазмещение();
    this.renderer.render(this.scene, this._activeCamera());
  }

  /**
   * Снимок текущего кадра как PNG.
   *
   * СОСТАВ КАДРА НЕ ВЫБИРАЕТСЯ ЗДЕСЬ, и это главное свойство метода. Материал, вариант,
   * поза анимации, камера, уровень детализации, глина, экспозиция и свет уже выбраны
   * человеком в окне — снимок берёт РОВНО ТО, что он видит. Отдельного набора настроек
   * показа у рендера нет и быть не должно: два источника правды разошлись бы на первом
   * же кадре, и человек получил бы картинку, которой не видел.
   *
   * ПРОЗРАЧНОСТЬ БЕСПЛАТНА: рендерер создан с `alpha: true`, фон не закрашивается, земли
   * под моделью нет. Просить о ней нечего — она уже есть; `background` нужен обратному
   * случаю, когда человеку нужна залитая подложка.
   *
   * ПОЧЕМУ ЧЕРЕЗ ВТОРОЕ ПОЛОТНО. У рендерера нет `preserveDrawingBuffer`, то есть буфер
   * живёт до конца текущего такта. `drawImage` копирует его СИНХРОННО, сразу после
   * отрисовки, и дальше можно спокойно ждать `toBlob`. Прямой `canvas.toBlob` на
   * полотне WebGL полагался бы на то, что снимок берётся в момент вызова, — в спецификации
   * это не обещано.
   *
   * ЦЕНА НАЗВАНА: three.js рисует с ПРЕДУМНОЖЕННОЙ альфой. На полупрозрачных пикселях —
   * стекло, мягкий край листа, сглаженный силуэт — цвет по кромке уходит на единицы.
   * Обычно незаметно; видно на стекле поверх тёмного. Лечится флагом
   * `premultipliedAlpha: false` у рендерера, но он меняет и живое окно, поэтому менять
   * его без замера нельзя.
   *
   * @param width  ширина в пикселях; по умолчанию — как на экране
   * @param height высота; по умолчанию — как на экране
   * @param background цвет подложки CSS-строкой либо `null` — прозрачный фон
   */
  async snapshot({ width, height, background = null }: {
    width?: number; height?: number; background?: string | null;
  } = {}): Promise<{ blob: Blob; width: number; height: number } | null> {
    if (!this.model) return null;

    const было = new THREE.Vector2();
    this.renderer.getSize(было);
    const прежнийМасштаб = this.renderer.getPixelRatio();

    // Потолок видеокарты, а не наша выдумка: за ним отрисовка молча даёт пустой кадр.
    // Обрезаем и СООБЩАЕМ настоящий размер в ответе — обещать 8К и отдать 4К нельзя.
    const gl = this.renderer.getContext();
    const потолок = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    const w = Math.max(1, Math.min(потолок, Math.round(width || было.x * прежнийМасштаб)));
    const h = Math.max(1, Math.min(потолок, Math.round(height || было.y * прежнийМасштаб)));

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const g = out.getContext('2d');
    if (!g) return null;

    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this._applyAspect(w / h);
      this.renderFrame();
      if (background) {
        g.fillStyle = background;
        g.fillRect(0, 0, w, h);
      }
      g.drawImage(this.canvas, 0, 0, w, h);
    } finally {
      // Возврат через _onResize, а не через запомненные числа: он единственный знает
      // ВСЁ, что зависит от размера, и не разойдётся с ним при следующей правке.
      this.renderer.setPixelRatio(прежнийМасштаб);
      this._onResize();
      this.renderFrame();
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    return blob ? { blob, width: w, height: h } : null;
  }

  /**
   * Полное состояние камеры — для синхронизации двух вьюпортов.
   *
   * Сюда входят near/far, а не только позиция с целью. Раньше их не было, и это
   * ломало главное свойство сравнения: правый вьюпорт грузился с чужой позицией,
   * но со СВОИМИ near/far — а их выставляет только frame(), которого при загрузке
   * с готовой камерой не происходит. Оставались значения из конструктора
   * (0.01 / 1000), тогда как слева стояло dist/100. При наезде камеры детали
   * начинали срезаться в одном окне раньше, чем в другом, и разница выглядела
   * как последствие оптимизации, хотя была разницей настроек показа.
   *
   * Пределы приближения тоже здесь: иначе колесо мыши упирается в разных точках
   * и связанные камеры расходятся на краях диапазона.
   */
  getCameraState(): CameraState {
    // Простые тройки чисел, а не THREE.Vector3: снимок уезжает в соседний вьюпорт, и
    // форма движка в этих данных сделала бы второй движок невозможным (contract.ts).
    const p = this.camera.position;
    const t = this.controls.target;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      near: this.camera.near,
      far: this.camera.far,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance,
    };
  }

  /** Применить состояние камеры от другого вьюпорта (без анимации damping-скачка). */
  applyCameraState(state: CameraState | null) {
    if (!state) return;
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.controls.target.set(state.target.x, state.target.y, state.target.z);
    if (Number.isFinite(state.near) && Number.isFinite(state.far)) {
      this.camera.near = state.near;
      this.camera.far = state.far;
      this.camera.updateProjectionMatrix(); // без этого near/far не вступят в силу
    }
    if (Number.isFinite(state.minDistance)) this.controls.minDistance = state.minDistance;
    if (Number.isFinite(state.maxDistance)) this.controls.maxDistance = state.maxDistance;
    this.controls.update();
  }

  _disposeModel() {
    if (!this.model) return;
    // Микшер держит ссылки на кости и треки этой модели — снимать до dispose,
    // иначе освобождённая геометрия остаётся живой через кэш AnimationMixer.
    this._disposeMixer();
    // Привод развёрток держит ССЫЛКИ НА ТЕКСТУРЫ этой модели. Не снять — и следующий
    // сдвиг ползунка будет писать в текстуры, которые уже освобождены.
    this._uv = null;
    // Переключатель вариантов замкнут на parser ЭТОЙ загрузки и на материалы, которые
    // сейчас будут освобождены. Оставить — и он полезет в чужую модель.
    // Уровни держат ссылки на узлы этой модели — в том числе на запасные, которые в
    // сцену мог добавить показ. Не снять — и они переживут модель.
    this._lods = null;
    this._lod = null;
    // Рамки держат ссылки на узлы ЭТОЙ модели. Не снять — переживут её и обведут пустоту.
    this.setInteractivityMarks(false);
    this._interactive = [];
    this._interactiveAll = [];
    this._interactiveOff = new Set<number>();
    // Исполнитель держит отложенные запуски. Не снять — они оживут над следующей
    // моделью и подвинут её узлы (та же беда, что была у запасных уровней детализации).
    this._behaviour?.dispose();
    this._behaviour = null;
    if (this._behaviourMixer) {
      this._behaviourMixer.stopAllAction();
      if (this.model) this._behaviourMixer.uncacheRoot(this.model);
      this._behaviourMixer = null;
    }
    this._selectVariant = null;
    this._variants = [];
    this._variant = null;
    // Камеры автора живут В МОДЕЛИ и сейчас будут освобождены вместе с ней. Не снять
    // ссылки — и рисовать продолжим через камеру, которой уже нет; вернуть свою орбиту
    // тоже обязаны, иначе следующая модель откроется через чужой мёртвый ракурс.
    this._fileCameras = [];
    this._cameraIndex = null;
    // Габарит принадлежит ЭТОЙ модели: у следующей он другой, и оставленный старый
    // положил бы затемнение мимо неё.
    this._clayBounds = null;
    this.scene.fog = null;
    this.controls.enabled = true;
    // Родные материалы возвращаем НА МЕСТО перед выгрузкой. Иначе они остались бы
    // висеть только в нашей карте: обход освобождения ходит по мешам и до снятых
    // материалов (а с ними до их текстур) не добрался бы — молчаливая утечка на
    // каждой смене модели.
    for (const [mesh, mat] of this._origMaterials) mesh.material = mat;
    this._origMaterials.clear();
    this.scene.remove(this.model);
    disposeSubtree(this.model);
    this.model = null;
  }

  /** Полностью освободить ресурсы просмотрщика. */
  dispose() {
    this._disposeModel();
    // Глина принадлежит просмотрщику, а не модели: она общая на все загрузки,
    // поэтому _disposeModel её не трогает, а здесь освободить обязаны.
    for (const mat of this._clay.values()) mat.dispose();
    this._clay.clear();
    if (this._clayMap) { this._clayMap.dispose(); this._clayMap = null; }
    this._resizeObserver.disconnect();
    this.controls.dispose();
    this._draco.dispose();
    this._ktx2.dispose();
    if (this.scene.environment) this.scene.environment.dispose();
    this.renderer.dispose();
  }

  _onResize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const { clientWidth, clientHeight } = parent;
    if (!clientWidth || !clientHeight) return;
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
    // Активная камера может быть авторской — ей пропорции тоже нужны, иначе кадр
    // растянут (см. _applyAspect).
    this._applyAspect();
    this.renderer.setSize(clientWidth, clientHeight, false);
  }
}
