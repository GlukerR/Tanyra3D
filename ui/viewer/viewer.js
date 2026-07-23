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
function detectSource(gltf) {
  const used = (gltf && gltf.parser && gltf.parser.json && gltf.parser.json.extensionsUsed) || [];
  return {
    draco: used.includes('KHR_draco_mesh_compression'),
    meshopt: used.includes('EXT_meshopt_compression'),
    ktx2: used.includes('KHR_texture_basisu'),
  };
}

/**
 * Самодостаточный просмотрщик одной модели: рендерер, сцена, студийный IBL-свет,
 * орбитальные контролы, авто-кадрирование под размер модели.
 */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.model = null;

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
    this._disposeModel();

    const gltf = await this._loader.loadAsync(url, onProgress);
    this.model = gltf.scene;
    this.scene.add(this.model);
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

  /** Обновить контролы и отрисовать один кадр (цикл гонит dual-viewport.js). */
  renderFrame() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Абсолютное состояние камеры — для синхронизации двух вьюпортов. */
  getCameraState() {
    return {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
    };
  }

  /** Применить состояние камеры от другого вьюпорта (без анимации damping-скачка). */
  applyCameraState(state) {
    if (!state) return;
    this.camera.position.copy(state.position);
    this.controls.target.copy(state.target);
    this.controls.update();
  }

  _disposeModel() {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((obj) => {
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
