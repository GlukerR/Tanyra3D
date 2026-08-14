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
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
// Контракт движка просмотра. Импорт типов, а не кода: в собранный файл он не попадает.
import type { CameraState, LoadOptions, ViewerLike } from "./contract.js";
import { buildUvPointerDriver, stripUvTransformTracks, type UvPointerDriver } from "./pointer-uv.js";

// Пути к декодерам — тоже из node_modules/three через /vendor-роут сервера (server.mjs).
const DRACO_DECODER_PATH = "/vendor/three/examples/jsm/libs/draco/gltf/";
const KTX2_TRANSCODER_PATH = "/vendor/three/examples/jsm/libs/basis/";

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
  // Появляются после первой удачной загрузки — до неё полей нет вовсе, отсюда `?`.
  declare stats?: ReturnType<typeof computeSceneStats>;
  declare detected?: ReturnType<typeof detectSource>;
  declare clips: THREE.AnimationClip[];
  declare clipIndex?: number;
  declare _mixer?: THREE.AnimationMixer | null;
  declare _action?: THREE.AnimationAction | null;
  /** Привод развёрток текстур по указателю — вне AnimationMixer, см. pointer-uv.ts. */
  declare _uv?: UvPointerDriver | null;

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
  }

  _initLoaders() {
    this._draco = new DRACOLoader();
    this._draco.setDecoderPath(DRACO_DECODER_PATH);

    this._ktx2 = new KTX2Loader();
    this._ktx2.setTranscoderPath(KTX2_TRANSCODER_PATH);
    this._ktx2.detectSupport(this.renderer);

    this._loader = new GLTFLoader();
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
    } catch (err) {
      console.warn('KHR_animation_pointer: плагин не зарегистрирован, анимация по указателю показана не будет', err);
    }
  }

  /**
   * Загрузить модель по URL. Предыдущая модель выгружается (dispose) — просмотрщик
   * переиспользуется для перезагрузки (оригинал → оптимизированный и т.п.).
   */
  async load(url: string, { onProgress, camera = null }: LoadOptions = {}) {
    // Метка этой загрузки. Разбор GLB — это секунды, и за них человек успевает нажать
    // «Пересобрать» или переключить модель. Раньше это кончалось так: обе загрузки
    // проходили _disposeModel() по ЕЩЁ ПУСТОЙ сцене, а потом обе добавляли свою модель.
    // Вторая записывалась в this.model, первая оставалась в сцене навсегда — никем не
    // отслеживаемая, невыгружаемая, поверх новой. На экране это выглядело как «куча
    // объектов» и огромный светящийся блок: две модели разного масштаба в одном кадре,
    // камера наведена на одну из них.
    const token = ++this._loadToken;
    this._disposeModel();

    const gltf = await this._loader.loadAsync(url, onProgress);
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
    this._setupAnimations(gltf.animations);
    // camera передан (сборка/ребилд той же модели) → СОХРАНИТЬ ракурс: приближённая
    // пользователем деталь остаётся на месте. Иначе (новая модель) — авто-кадрирование.
    if (camera) this.applyCameraState(camera);
    else this.frame();
    this.stats = computeSceneStats(this.model);
    this.detected = detectSource(gltf);
    return gltf;
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
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
    this.scene.remove(this.model);
    disposeSubtree(this.model);
    this.model = null;
  }

  /** Полностью освободить ресурсы просмотрщика. */
  dispose() {
    this._disposeModel();
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
    this.renderer.setSize(clientWidth, clientHeight, false);
  }
}
