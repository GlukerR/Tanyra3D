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
export class Viewer implements ViewerLike {
  // Только объявления: `declare` проверяется компилятором и не попадает в собранный
  // файл — значения по-прежнему присваивают конструктор и методы _init*().
  declare canvas: HTMLCanvasElement;
  declare model: THREE.Object3D | null;
  declare _loadToken: number;
  declare renderer: THREE.WebGLRenderer;
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
  declare _diffRef?: THREE.Texture[] | null;
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
   * Карта различий двух текстур: где пиксели те же — зелено, где ушли — красно.
   *
   * РАЗРЕШЕНИЕ БЕРЁТСЯ У ЭТАЛОНА, и уменьшенная картинка растягивается на него без
   * сглаживания. Решение Александра 2026-09-01: «приводить к меньшему из двух не нужно,
   * просто накладывай новые пиксели на старые крупные». Так один пиксель тысячной
   * текстуры ложится на четыре пикселя двухтысячной, и на карте видно ОБЕ потери — и от
   * пережатия, и от уменьшения. Обе настоящие: «просишь уменьшить — нужно понимать, что
   * будут потери».
   *
   * `imageSmoothingEnabled = false` здесь обязателен. Со сглаживанием браузер придумал бы
   * промежуточные цвета, которых в файле нет, и карта показала бы плавную разницу там, где
   * на деле квадрат в четыре пикселя одного цвета.
   */
  _diffTexture(эталон: THREE.Texture, стало: THREE.Texture | null): THREE.CanvasTexture | null {
    const и1 = эталон.image as CanvasImageSource & { width?: number; height?: number };
    if (!и1 || !и1.width || !и1.height) return null;
    const w = и1.width;
    const h = и1.height;

    const снять = (t: THREE.Texture | null) => {
      const img = t?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
      if (!img || !img.width) return null;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };

    const a = снять(эталон);
    const b = снять(стало);
    if (!a) return null;

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const карта = ctx.createImageData(w, h);

    for (let i = 0; i < a.length; i += 4) {
      // Отклонение — САМЫЙ ушедший канал, а не их среднее. Среднее прячет сдвиг одного
      // цвета: красный, уехавший на треть, при усреднении с целыми зелёным и синим даёт
      // «одну девятую», и карта промолчит о том, что человек увидит глазами.
      let d = 0;
      if (b) for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k]! - b[i + k]!));
      const t = d / 255;
      // Тот же зелёный→красный, что и у плотности: одна шкала на всё приложение, человеку
      // не приходится держать в голове две.
      карта.data[i] = Math.round(255 * Math.min(1, t * 2));
      карта.data[i + 1] = Math.round(255 * Math.min(1, (1 - t) * 2));
      карта.data[i + 2] = 40;
      карта.data[i + 3] = 255;
    }
    ctx.putImageData(карта, 0, 0);
    const tex = new THREE.CanvasTexture(out);
    tex.flipY = эталон.flipY;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Материал одной детали в режиме различий.
   *
   * ЛЕВОЕ ОКНО — ЭТАЛОН и красится ровно зелёным. Не «зелёной картинкой», а сплошным
   * цветом: у эталона отклонений нет по определению, и рисовать ему карту значило бы
   * тратить работу на ответ, который известен заранее.
   *
   * ПРАВОЕ сравнивает свою карту с эталонной. Деталь без текстуры зелёная там и там:
   * менять в ней нечего, и красить её было бы враньём.
   *
   * СОПОСТАВЛЕНИЕ ПО ПОРЯДКУ ОБХОДА, и это честная слабость. Обе модели — одна и та же
   * сцена, и порядок деталей в них совпадает, пока сборка не меняет их состав. Склейка
   * мешей его меняет: деталей становится меньше, и пара «эталон ↔ результат» разъезжается.
   * В таком случае эталона на нужном месте просто нет, и деталь остаётся зелёной — то есть
   * мы молчим, а не показываем чужую разницу. Врать хуже, чем не ответить.
   */
  _texdiffFor(mesh: THREE.Mesh, родной: THREE.Material | null, номер: number) {
    const зелёный = () => new THREE.MeshBasicMaterial({
      color: 0x22c55e, side: THREE.DoubleSide, toneMapped: false,
    });
    const эталоны = this._diffRef;
    // Эталона нет — это левое окно либо деталь, которой в паре не нашлось.
    if (!эталоны) return зелёный();
    const карта = (родной as THREE.MeshStandardMaterial | null)?.map || null;
    const эталон = эталоны[номер] || null;
    if (!эталон) return зелёный();
    const diff = this._diffTexture(эталон, карта);
    if (!diff) return зелёный();
    void mesh;
    return new THREE.MeshBasicMaterial({ map: diff, side: THREE.DoubleSide, toneMapped: false });
  }

  /**
   * Текстуры этой модели по порядку обхода — то, что обвязка передаёт второму окну.
   *
   * Дырки в списке (деталь без текстуры) сохраняются намеренно: номер детали и есть ключ
   * сопоставления, и сжать список значило бы сдвинуть все следующие пары.
   */
  textureRefs(): THREE.Texture[] {
    const out: THREE.Texture[] = [];
    if (!this.model) return out;
    this.model.traverse((o: MaybeMesh) => {
      if (!o.isMesh || !o.material) return;
      const first = Array.isArray(o.material) ? o.material[0] : o.material;
      out.push((first as THREE.MeshStandardMaterial | undefined)?.map as THREE.Texture);
    });
    return out;
  }

  /** Эталон для режима различий. `null` — окно само является эталоном. */
  setDiffReference(refs: THREE.Texture[] | null) {
    this._diffRef = refs;
    if (this._display === 'texdiff') this._applyDisplayMaterial();
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
    if (this._display !== 'wire' && this._display !== 'texdiff') this._dropDensityMaterials();
    if (this._display !== 'file') {
      // Границы шкалы плотности считаются ОДИН раз на всю модель и до обхода: цвет каждой
      // детали зависит от того, какая в этой модели самая плотная и какая самая редкая.
      let min = Infinity;
      let max = 0;
      // Порядковый номер детали: им же обвязка нумерует эталонные текстуры. Совпадение
      // держится на том, что обе модели обходятся одинаково — см. `_texdiffFor`.
      let счётчик = 0;
      if (this._display === 'wire') {
        this.model.traverse((o: MaybeMesh) => {
          if (!o.isMesh) return;
          const v = this._densityOf(o as unknown as THREE.Mesh);
          if (v > 0) { min = Math.min(min, v); max = Math.max(max, v); }
        });
        if (!Number.isFinite(min)) min = 0;
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
        const родной = this._origMaterials.get(mesh) ?? o.material!;
        const first = Array.isArray(родной) ? родной[0] : родной;
        if (this._display === 'wire') {
          const m = this._wireMaterial(mesh, min, max);
          this._densityMats.add(m);
          o.material = m;
          return;
        }
        if (this._display === 'texdiff') {
          const m = this._texdiffFor(mesh, first ?? null, счётчик++);
          this._densityMats.add(m);
          o.material = m;
          return;
        }
        o.material = this._clayFor(first ? first.side : THREE.FrontSide, first);
      });
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
