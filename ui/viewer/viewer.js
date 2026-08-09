// viewer.js — встроенный 3D-просмотрщик одной GLB-модели (движок Three.js).
// Портирован из просмотрщика D:\others\threejsview (класс Viewer, Three.js r185) и
// адаптирован под ПРОИЗВОЛЬНЫЕ модели: авто-кадрирование по bounding box вместо
// хардкод-камеры + KTX2Loader (оптимизированные файлы бывают сжаты в KTX2, чего в
// исходном просмотрщике не было) + корректная выгрузка/перезагрузка модели.
//
// Это конкретная РЕАЛИЗАЦИЯ движка просмотра за узким интерфейсом (см. createViewer в
// index.js) — по аналогии с core/addon в ядре: обвязка двух вьюпортов не знает про
// Three.js, а будущий движок/режим (дизайнерский режим, показ пропавших точек, свой
// свет) подключается через тот же интерфейс, не переписывая dual-viewport.js.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Пути к декодерам — тоже из node_modules/three через /vendor-роут сервера (server.mjs).
const DRACO_DECODER_PATH = "/vendor/three/examples/jsm/libs/draco/gltf/";
const KTX2_TRANSCODER_PATH = "/vendor/three/examples/jsm/libs/basis/";

/**
 * Освободить память под поддеревом: геометрии, материалы и все их текстуры.
 * Отдельной функцией, потому что освобождать приходится два разных дерева — модель,
 * которая была в сцене, и модель устаревшей загрузки, которая до сцены не дошла.
 * Из сцены объект снимает вызывающий: у второго случая сцены и нет.
 */
function disposeSubtree(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        for (const key of Object.keys(mat)) {
          const val = mat[key];
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
function computeSceneStats(root) {
  let triangles = 0;
  let vertices = 0;
  let drawCalls = 0;
  const materials = new Set();
  const textures = new Set();

  root.traverse((o) => {
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
        const val = m[key];
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
function detectSource(gltf) {
  const json = (gltf && gltf.parser && gltf.parser.json) || {};
  const used = json.extensionsUsed || [];
  const images = json.images || [];
  const hasKtx2Mime = images.some((img) => img.mimeType === 'image/ktx2');
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
function detectOpportunity(json) {
  const nodes = json.nodes || [];
  const users = new Map();
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
 * Самодостаточный просмотрщик одной модели: рендерер, сцена, студийный IBL-свет,
 * орбитальные контролы, авто-кадрирование под размер модели.
 */
export class Viewer {
  constructor(canvas) {
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
    this._resizeObserver.observe(canvas.parentElement);
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
  }

  /**
   * Загрузить модель по URL. Предыдущая модель выгружается (dispose) — просмотрщик
   * переиспользуется для перезагрузки (оригинал → оптимизированный и т.п.).
   */
  async load(url, { onProgress, camera = null } = {}) {
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
  _setupAnimations(clips) {
    this._disposeMixer();
    this.clips = Array.isArray(clips) ? clips : [];
    if (!this.clips.length || !this.model) return;
    this._mixer = new THREE.AnimationMixer(this.model);
    this.playClip(0);
  }

  /** Включить клип по индексу. Прежнее действие останавливается. */
  playClip(index) {
    if (!this._mixer || !this.clips.length) return;
    const i = Math.max(0, Math.min(index, this.clips.length - 1));
    this._mixer.stopAllAction();
    this._action = this._mixer.clipAction(this.clips[i]);
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
  setAnimationTime(seconds) {
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
  setExposure(value) {
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
  getCameraState() {
    return {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance,
    };
  }

  /** Применить состояние камеры от другого вьюпорта (без анимации damping-скачка). */
  applyCameraState(state) {
    if (!state) return;
    this.camera.position.copy(state.position);
    this.controls.target.copy(state.target);
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
