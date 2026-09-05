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
import type { CameraState, DisplayMode, LoadOptions, ViewerLike } from "./contract.js";
import { DISPLAY_MODES } from "./contract.js";
import { buildUvPointerDriver, stripUvTransformTracks, type UvPointerDriver } from "./pointer-uv.js";
import { detectLods, showLod, type LodSet } from "./lod.js";
import { applyNodeVisibility, findInteractive, InteractivityHighlight, type InteractivePart } from "./interactivity.js";
import { InteractivityRuntime } from "./interactivity-runtime.js";
import { GLTFDiffuseTransmissionExtension } from "./diffuse-transmission.js";

const DRACO_DECODER_PATH = "/vendor/three/examples/jsm/libs/draco/gltf/";
const KTX2_TRANSCODER_PATH = "/vendor/three/examples/jsm/libs/basis/";

const FOREIGN_FORMATS = ["stl", "ply", "fbx", "obj"];

type MaybeMesh = THREE.Object3D & {
  isMesh?: boolean | undefined;
  geometry?: THREE.BufferGeometry | undefined;
  material?: THREE.Material | THREE.Material[] | undefined;
};

interface GltfJson {
  extensionsUsed?: string[];
  images?: Array<{ mimeType?: string }>;
  nodes?: Array<{ mesh?: number }>;
}

export type { CameraState, LoadOptions } from "./contract.js";

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

function makeClayMatcap() {
  const SIZE = 256;
  const R = SIZE / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

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

  const band = ctx.createLinearGradient(0, SIZE * 0.12, 0, SIZE * 0.52);
  band.addColorStop(0.00, "rgba(255,255,255,0)");
  band.addColorStop(0.42, "rgba(255,255,255,0.26)");
  band.addColorStop(0.58, "rgba(255,255,255,0.26)");
  band.addColorStop(1.00, "rgba(255,255,255,0)");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const bx = SIZE * 0.72;
  const by = SIZE * 0.80;
  const bounce = ctx.createRadialGradient(bx, by, SIZE * 0.01, bx, by, SIZE * 0.32);
  bounce.addColorStop(0, "rgba(120,144,180,0.50)");
  bounce.addColorStop(1, "rgba(126,146,178,0)");
  ctx.fillStyle = bounce;
  ctx.fillRect(0, 0, SIZE, SIZE);

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
    opportunity: detectOpportunity(json),
  };
}

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

const FILE_MODE_ENV = 0.15;

type FileCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export type { DisplayMode } from "./contract.js";

type SlotMaps = Partial<Record<(typeof Viewer.DIFF_SLOTS)[number], THREE.Texture | null>>;

type DiffRef = { имя: string; карты: SlotMaps };

type DiffRaw = {
  data: Uint8Array; w: number; h: number; max: number; среднее: number;
  ssim: number;
  flipY: boolean;
};

type DiffCached = {
  raw: DiffRaw;
  tex: THREE.CanvasTexture;
  dispose(): void;
};

export class Viewer implements ViewerLike {
  declare canvas: HTMLCanvasElement;
  declare model: THREE.Object3D | null;
  declare _loadToken: number;
  declare renderer: THREE.WebGLRenderer;
  declare _пиксели?: Map<string, Uint8ClampedArray>;
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
  declare _clayNormals?: Set<THREE.BufferGeometry>;
  declare _display: DisplayMode;
  declare _origMaterials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
  declare _clay: Map<string, THREE.MeshMatcapMaterial>;
  declare _clayMap?: THREE.Texture | null;
  readonly _densityMats = new Set<THREE.MeshBasicMaterial>();
  declare _diffRef?: DiffRef[] | null;
  declare _diffByName?: Map<string, SlotMaps[]> | null;
  _diffCache = new Map<string, DiffCached>();
  readonly _diffQueue: Array<{
    mesh: THREE.Mesh; родной: THREE.Material | null; эталон: SlotMaps; ключ: string;
  }> = [];
  declare _diffTimer?: number | null;
  declare _onBusy?: ((busy: boolean) => void) | null;
  declare _densityScale?: [number, number] | null;
  declare _clayBounds?: { center: THREE.Vector3; radius: number } | null;
  declare _packFiles: string[];

  declare _resolveAsset: ((url: string) => string | null) | null;
  declare stats?: ReturnType<typeof computeSceneStats>;
  declare detected?: ReturnType<typeof detectSource>;
  declare clips: THREE.AnimationClip[];
  declare clipIndex?: number;
  declare _mixer?: THREE.AnimationMixer | null;
  declare _action?: THREE.AnimationAction | null;
  declare _uv?: UvPointerDriver | null;
  declare _interactive?: InteractivePart[];
  declare _interactiveAll?: InteractivePart[];
  declare _interactiveOff?: Set<number>;
  declare onInteractivePick?: ((part: { name: string; responded: boolean }) => void) | null;
  declare _interactiveMarks?: InteractivityHighlight | null;
  declare _behaviour?: InteractivityRuntime | null;
  declare _behaviourMixer?: THREE.AnimationMixer | null;
  declare _behaviourAt?: number;

  declare _lods?: LodSet | null;
  declare _lod?: number | 'all' | null;
  declare _variants?: string[];
  declare _variant?: string | null;
  declare _selectVariant?: ((o: THREE.Object3D, name: string | null) => Promise<unknown>) | null;
  declare _key: THREE.DirectionalLight;
  declare _modelLights?: THREE.Light[];
  declare _lightMode?: 'studio' | 'file' | 'none';
  declare _fileCameras?: FileCamera[];
  declare _cameraIndex?: number | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.model = null;
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

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  _initCamera() {
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

    try {
      this._loader.register((parser) => orphanPointerGuard(parser));
      this._loader.register((parser) => new GLTFAnimationPointerExtension(parser));
      this._loader.register((parser) => new GLTFMaterialsVariantsExtension(parser));
      this._loader.register((parser) => new GLTFDiffuseTransmissionExtension(parser));
    } catch (err) {
      console.warn('KHR_animation_pointer: плагин не зарегистрирован, анимация по указателю показана не будет', err);
    }
  }

  async load(url: string, { onProgress, camera = null, format = null }: LoadOptions = {}) {
    const token = ++this._loadToken;
    this._disposeModel();

    const gltf = FOREIGN_FORMATS.includes(String(format || '').toLowerCase())
      ? await this._loadForeign(url, String(format).toLowerCase())
      : await this._loader.loadAsync(url, onProgress);
    if (token !== this._loadToken) {
      disposeSubtree(gltf.scene);
      return null;
    }
    this.model = gltf.scene;
    this.scene.add(this.model);
    this._uv = await buildUvPointerDriver(gltf);
    if (this._uv) stripUvTransformTracks(gltf.animations || []);
    this._readVariants(gltf);
    this._lods = await detectLods(gltf as never);
    this._lod = null;
    applyNodeVisibility(gltf as never);
    this._interactiveAll = findInteractive(gltf as never);
    this._interactiveOff = new Set<number>();
    this._interactive = [...this._interactiveAll];
    this._interactiveMarks = null;
    if (this._interactive.length) this.setInteractivityMarks(true);
    this._modelLights = this._collectModelLights();
    this.setLightMode('studio');
    this._readFileCameras(gltf);
    this.setCamera(null);
    this._setupAnimations(gltf.animations);
    this._startBehaviour(gltf as never);
    if (camera) this.applyCameraState(camera);
    else this.frame();
    this.stats = computeSceneStats(this.model);
    this.detected = detectSource(gltf);
    this._applyDisplayMaterial();
    return gltf;
  }

  setDisplayMaterial(mode: DisplayMode) {
    this._display = DISPLAY_MODES.includes(mode) ? mode : 'file';
    this._applyDisplayMaterial();
    return true;
  }

  getDisplayMaterial(): DisplayMode {
    return this._display;
  }

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
    const сторона = (x: number) => Math.max(Number.isFinite(x) ? x : 0, 1e-4);
    const dx = сторона(bb.max.x - bb.min.x);
    const dy = сторона(bb.max.y - bb.min.y);
    const dz = сторона(bb.max.z - bb.min.z);
    const площадь = 2 * (dx * dy + dy * dz + dx * dz);
    return площадь > 0 ? треугольников / площадь : 0;
  }

  _densityFor(mesh: THREE.Mesh, min: number, max: number) {
    const v = this._densityOf(mesh);
    const lg = (x: number) => Math.log10(Math.max(x, 1e-9));
    const a = lg(min);
    const b = lg(max);
    const t = b - a > 1e-6 ? Math.min(1, Math.max(0, (lg(v) - a) / (b - a))) : 0;
    const color = new THREE.Color();
    color.setHSL((1 - t) * 0.33, 0.85, 0.5);
    return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
  }

  static readonly ПОЛНЫЙ_КРАСНЫЙ = 0.05;

  static readonly ПОТОЛОК_СРАВНЕНИЯ = 1024;

  static readonly ОКНО_SSIM = 8;

  static readonly ПОРОГ_SSIM = 0.25;

  static readonly DIFF_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const;

  _пикселиТекстуры(t: THREE.Texture | null | undefined, w: number, h: number): Uint8ClampedArray | null {
    const img = t?.image as { width?: number } | undefined;
    if (!t || !img || !img.width) return null;
    if (!this.renderer) return null;

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

    const вSRGB = t.colorSpace === THREE.SRGBColorSpace;
    const байт = (v: number) => {
      const л = Math.min(1, Math.max(0, v));
      const s = вSRGB ? (л <= 0.0031308 ? л * 12.92 : 1.055 * Math.pow(л, 1 / 2.4) - 0.055) : л;
      return Math.round(s * 255);
    };

    // GPU rows are bottom-up
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

    const N = w * h;
    const яркость = (a: Uint8ClampedArray, i: number) => 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!;

    const ssimПотеря = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      const X = new Float32Array(N);
      const Y = new Float32Array(N);
      for (let p = 0, i = 0; p < N; p++, i += 4) { X[p] = яркость(a, i); Y[p] = яркость(b, i); }

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
        let цвет = 0;
        for (let n = 0; n < 3; n++) цвет = Math.max(цвет, Math.abs(a[i + n]! - b[i + n]!));
        const доляЦвета = цвет / (255 * Viewer.ПОЛНЫЙ_КРАСНЫЙ);
        const п = потери[к]![p]!;
        суммаSSIM += п;
        считано++;
        const доляSSIM = п / Viewer.ПОРОГ_SSIM;
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

  _diffTexture(эталоны: SlotMaps, ставшие: SlotMaps): THREE.CanvasTexture | null {
    const сырое = this._diffRaw(эталоны, ставшие);
    return сырое ? this._diffColor(сырое) : null;
  }

  _diffColor(сырое: DiffRaw): THREE.CanvasTexture | null {
    const { data, w, h } = сырое;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const карта = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < data.length; p++, i += 4) {
      const t = data[p]! / 255;
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

  _texdiffFor(родной: THREE.Material | null, эталон: SlotMaps, ключ: string) {
    const готовая = this._diffCache.get(ключ);
    if (готовая) return this._картой(готовая.tex, Viewer._откудаРазмещение(родной));

    const m = родной as THREE.MeshStandardMaterial | null;
    const ставшие: SlotMaps = {};
    for (const k of Viewer.DIFF_SLOTS) ставшие[k] = (m?.[k] as THREE.Texture | null) || null;

    const raw = this._diffRaw(эталон, ставшие);
    if (!raw) return this._стеклоДиффа();

    const tex = this._diffColor(raw);
    if (!tex) return this._стеклоДиффа();
    this._diffCache.set(ключ, { raw, tex, dispose() { this.tex.dispose(); } });
    return this._картой(tex, Viewer._откудаРазмещение(родной));
  }


  diffScale(): number | null {
    if (!this._diffCache.size) return null;
    let худшая = 1;
    for (const я of this._diffCache.values()) if (я.raw.ssim < худшая) худшая = я.raw.ssim;
    return худшая;
  }

  _картой(map: THREE.CanvasTexture, источник?: THREE.Texture | null) {
    let карта = map;
    if (источник) {
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

  static _откудаРазмещение(источник: THREE.Material | SlotMaps | null): THREE.Texture | null {
    const m = источник as Record<string, THREE.Texture | null | undefined> | null;
    if (!m) return null;
    if (m.map) return m.map;
    for (const k of Viewer.DIFF_SLOTS) {
      if (m[k]) return m[k]!;
    }
    return null;
  }

  static _перенестиРазмещение(из: THREE.Texture, в: THREE.Texture) {
    в.offset.copy(из.offset);
    в.repeat.copy(из.repeat);
    в.center.copy(из.center);
    в.rotation = из.rotation;
    в.wrapS = из.wrapS;
    в.wrapT = из.wrapT;
    в.channel = из.channel;
    в.matrixAutoUpdate = true;
  }

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

  _стеклоДиффа() {
    return new THREE.MeshBasicMaterial({
      color: 0x9aa4ad, side: THREE.DoubleSide, toneMapped: false,
      transparent: true, opacity: 0.12, depthWrite: false,
    });
  }

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
      if (!m || виденные.has(m)) return;
      виденные.add(m);
      const карты: SlotMaps = {};
      for (const k of Viewer.DIFF_SLOTS) карты[k] = (m[k] as THREE.Texture | null) || null;
      out.push({ имя: m.name || '', карты });
    });
    return out;
  }


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

  setDensityScale(range: [number, number] | null) {
    this._densityScale = range;
    if (this._display === 'wire') this._applyDisplayMaterial();
  }

  useDiffStore(store: Map<string, DiffCached>) {
    this._diffCache = store;
  }


  setDiffReference(refs: DiffRef[] | null) {
    if (refs === this._diffRef) {
      if (this._display === 'texdiff') this._applyDisplayMaterial();
      return;
    }
    this._diffRef = refs;
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

  // content only, no placement
  static _ключПары(эталон: SlotMaps, ставшие: SlotMaps): string {
    const части: string[] = [];
    for (const k of Viewer.DIFF_SLOTS) {
      const a = эталон[k];
      const b = ставшие[k];
      if (!a && !b) continue;
      части.push(`${k}:${a?.uuid || '—'}>${b?.uuid || '—'}`);
    }
    return части.join('|');
  }

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

  _сопоставитель(): (o: THREE.Mesh) => SlotMaps | null {
    const refs = this._diffRef;
    const по = this._diffByName;
    if (!refs || !refs.length || !по) return () => null;

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

  _заглушкаДиффа() {
    return new THREE.MeshBasicMaterial({
      color: 0x5b6672, side: THREE.DoubleSide, toneMapped: false,
    });
  }

  _runDiffQueue() {
    if (this._diffTimer) return;
    if (!this._diffQueue.length) return;
    this._onBusy?.(true);
    const шаг = () => {
      if (this._display !== 'texdiff') {
        this._diffQueue.length = 0;
        this._diffTimer = null;
        this._onBusy?.(false);
        return;
      }
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
        this._пиксели?.clear();
        this._onBusy?.(false);
      }
    };
    this._diffTimer = requestAnimationFrame(шаг);
  }

  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this._onBusy = typeof fn === 'function' ? fn : null;
  }

  _dropDensityMaterials() {
    for (const m of this._densityMats) m.dispose();
    this._densityMats.clear();
  }

  _wireMaterial(mesh: THREE.Mesh, min: number, max: number) {
    const m = this._densityFor(mesh, min, max);
    m.wireframe = true;
    return m;
  }

  _clayFor(side: THREE.Side, source?: THREE.Material | null) {
    const tint = (source as THREE.MeshStandardMaterial | undefined)?.color;
    const hex = tint ? tint.getHex() : 0xffffff;
    const key = `${side}:${hex}`;
    let mat = this._clay.get(key);
    if (!mat) {
      if (!this._clayMap) this._clayMap = makeClayMatcap();
      mat = new THREE.MeshMatcapMaterial({ matcap: this._clayMap, side, color: hex });
      this._clay.set(key, mat);
    }
    return mat;
  }

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
    fog.near = Math.max(0.01, dist - radius * 0.85);
    fog.far = dist + radius * 1.15;
  }

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

  _dropClayNormals() {
    const мои = this._clayNormals;
    if (!мои?.size) return;
    for (const geometry of мои) geometry.deleteAttribute('normal');
    мои.clear();
  }

  _applyDisplayMaterial() {
    if (!this.model) return;
    if (this._display === 'clay') this._ensureClayNormals();
    else this._dropClayNormals();
    this._dropDensityMaterials();
    this._diffQueue.length = 0;
    if (this._display !== 'file') {
      let min = Infinity;
      let max = 0;
      const эталонДля = this._display === 'texdiff' ? this._сопоставитель() : null;
      if (this._display === 'wire') {
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
        const first = this._родной(mesh);
        if (this._display === 'wire') {
          const m = this._wireMaterial(mesh, min, max);
          this._densityMats.add(m);
          o.material = m;
          return;
        }
        if (this._display === 'texdiff') {
          const эталон = эталонДля?.(mesh) || null;
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
      if (this._display === 'texdiff') {
        if (this._diffQueue.length) this._runDiffQueue();
        else this._onBusy?.(false);
      }
      this._updateClayDepth();
      return;
    }
    for (const [mesh, mat] of this._origMaterials) mesh.material = mat;
    this._origMaterials.clear();
    this._updateClayDepth();
  }

  hasTextures() {
    return !!(this.stats && this.stats.textures > 0);
  }

  async _loadForeign(url: string, format: string) {
    const buf = await (await fetch(url)).arrayBuffer();

    if (format === 'fbx') {
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      const scene = new FBXLoader(this._manager).parse(buf, base);
      await this._applyNeighbourMaps(scene as unknown as THREE.Object3D, base);
      return { scene, animations: (scene as unknown as { animations?: unknown[] }).animations || [], parser: { json: {} }, userData: {} } as unknown as GLTF;
    }

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
        } catch {  }
      }
      const scene = loader.parse(text);
      return { scene, animations: [], parser: { json: {} }, userData: {} } as unknown as GLTF;
    }

    const geom = format === 'ply' ? new PLYLoader().parse(buf) : new STLLoader().parse(buf);
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

  async _applyNeighbourMaps(scene: THREE.Object3D, base: string) {
    if (!this._packFiles || !this._packFiles.length || !this._resolveAsset) return;

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
        if (slot === 'map' || slot === 'emissiveMap') tex.colorSpace = THREE.SRGBColorSpace;
        maps[slot] = tex;
      } catch {  }
    }
    if (!Object.keys(maps).length) return;

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
      if (maps.aoMap && o.geometry && !o.geometry.getAttribute('uv1') && o.geometry.getAttribute('uv')) {
        o.geometry.setAttribute('uv1', o.geometry.getAttribute('uv'));
      }
      o.material = Array.isArray(o.material)
        ? (o.material as THREE.Material[]).map(patch)
        : patch(o.material as THREE.Material);
    });
  }

  getStats() {
    return this.stats || null;
  }

  getDetection() {
    return this.detected || null;
  }

  frame() {
    if (!this.model) return;

    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.4;

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


  _setupAnimations(clips: THREE.AnimationClip[] | undefined) {
    this._disposeMixer();
    this.clips = Array.isArray(clips) ? clips : [];
    if (!this.clips.length || !this.model) return;
    this._mixer = new THREE.AnimationMixer(this.model);
    this.playClip(0);
    if (this._uv) this._uv.apply(0);
  }

  playClip(index: number) {
    if (!this._mixer || !this.clips.length) return;
    const i = Math.max(0, Math.min(index, this.clips.length - 1));
    this._mixer.stopAllAction();
    this._action = this._mixer.clipAction(this.clips[i]!);
    this._action.reset();
    this._action.play();
    this.clipIndex = i;
    this._mixer.setTime(0);
  }

  setAnimationTime(seconds: number) {
    const uvDur = this._uv ? this._uv.duration : 0;
    if (this._uv) this._uv.apply(uvDur > 0 ? seconds % uvDur : seconds);

    if (!this._mixer || !this._action) return;
    const dur = this._action.getClip().duration || 0;
    this._mixer.setTime(dur > 0 ? seconds % dur : seconds);
  }

  setExposure(value: number) {
    const v = Number(value);
    this.renderer.toneMappingExposure = Number.isFinite(v) ? v : 1;
  }

  setPackFiles(paths: string[] | null) {
    this._packFiles = Array.isArray(paths) ? paths.slice() : [];
  }

  setAssetResolver(resolve: ((url: string) => string | null) | null) {
    this._resolveAsset = typeof resolve === 'function' ? resolve : null;
  }

  _readVariants(gltf: GLTF) {
    const data = gltf.userData as { variants?: unknown } | undefined;
    const fns = (gltf as unknown as { functions?: { selectVariant?: unknown } }).functions;
    const names = Array.isArray(data?.variants) ? (data!.variants as unknown[]) : [];
    this._variants = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
    this._selectVariant = typeof fns?.selectVariant === 'function'
      ? (fns.selectVariant as (o: THREE.Object3D, name: string | null) => Promise<unknown>)
      : null;
    this._variant = null;
  }


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
      console.warn('KHR_interactivity: интерактив не проигрывается — не знаем: '
        + runtime.refusal.join(', '));
    }
    this._behaviour = runtime;
    runtime.start();
  }

  _setClickable(nodeIndex: number, on: boolean) {
    const all = this._interactiveAll ?? [];
    if (!all.length) return;
    const off = this._interactiveOff ?? (this._interactiveOff = new Set<number>());
    if (on) off.delete(nodeIndex);
    else off.add(nodeIndex);
    this._interactive = all.filter((p) => !off.has(p.nodeIndex));
    if (this._interactiveMarks) this.setInteractivityMarks(true);
  }

  pickInteractive(x: number, y: number): boolean {
    const parts = this._interactive ?? [];
    if (!parts.length || !this._behaviour) return false;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), this._activeCamera());
    const hits = ray.intersectObjects(parts.map((p) => p.object), true);
    if (!hits.length) return false;

    for (let obj: THREE.Object3D | null = hits[0]!.object; obj; obj = obj.parent) {
      const part = parts.find((p) => p.object === obj);
      if (!part) continue;
      const responded = this._behaviour.select(part.nodeIndex);
      this._interactiveMarks?.flash(part);
      this.renderFrame();
      this.onInteractivePick?.({ name: part.name, responded });
      return responded;
    }
    return false;
  }

  _advanceBehaviourAnimations() {
    const mixer = this._behaviourMixer;
    if (!mixer) return;
    const now = performance.now();
    const was = this._behaviourAt || 0;
    this._behaviourAt = now;
    if (!was) return;
    const dt = Math.min((now - was) / 1000, 0.1);
    if (dt > 0) mixer.update(dt);
  }

  getBehaviourInfo() {
    return {
      playable: !!this._behaviour && !this._behaviour.refusal.length,
      refusal: this._behaviour ? [...this._behaviour.refusal] : [],
    };
  }

  getInteractivityInfo() {
    const parts = this._interactive ?? [];
    return {
      count: parts.length,
      names: parts.map((p) => p.name),
      shown: !!this._interactiveMarks,
    };
  }

  setInteractivityMarks(on: boolean) {
    const parts = this._interactive ?? [];
    if (this._interactiveMarks) {
      this.scene.remove(this._interactiveMarks);
      this._interactiveMarks.dispose();
      this._interactiveMarks = null;
    }
    if (!on || !parts.length || !this.model) return false;
    const marks = new InteractivityHighlight(parts);
    this.scene.add(marks);
    this._interactiveMarks = marks;
    return true;
  }


  getLodInfo() {
    const set = this._lods;
    if (!set) return { count: 0, source: null, names: [] as string[], triangles: [] as number[], current: null };
    return {
      count: set.levels.length,
      source: set.source,
      names: set.levels.map((l) => l.name),
      triangles: set.levels.map((l) => l.triangles),
      current: this._lod ?? null,
    };
  }

  setLod(index: number | null) {
    if (!this._lods || !this.model) return false;
    if (index !== null && (index < 0 || index >= this._lods.levels.length)) return false;
    showLod(this._lods, this.model, index);
    this._lod = index;
    return true;
  }


  _readFileCameras(gltf: GLTF) {
    const cams: FileCamera[] = [];
    for (const cam of gltf.cameras || []) {
      const c = cam as FileCamera;
      const known = ('isPerspectiveCamera' in c && c.isPerspectiveCamera)
        || ('isOrthographicCamera' in c && c.isOrthographicCamera);
      if (!known) continue;
      if (!c.parent) continue;
      cams.push(c);
    }
    this._fileCameras = cams;
    this._cameraIndex = null;
  }

  getCameraInfo() {
    const cams = this._fileCameras || [];
    return {
      count: cams.length,
      names: cams.map((c) => c.name || ''),
      current: this._cameraIndex ?? null,
    };
  }

  setCamera(index: number | null) {
    const cams = this._fileCameras || [];
    if (index !== null && (index < 0 || index >= cams.length)) return false;
    this._cameraIndex = index;
    this.controls.enabled = index === null;
    this._applyAspect();
    return true;
  }

  _activeCamera(): FileCamera {
    const cams = this._fileCameras || [];
    const i = this._cameraIndex;
    return i === null || i === undefined ? this.camera : (cams[i] || this.camera);
  }

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
      const halfH = (cam.top - cam.bottom) / 2;
      const halfW = halfH * ratio;
      cam.left = -halfW;
      cam.right = halfW;
    } else if ('isPerspectiveCamera' in cam && cam.isPerspectiveCamera) {
      cam.aspect = ratio;
    }
    cam.updateProjectionMatrix();
  }


  _collectModelLights() {
    const found: THREE.Light[] = [];
    if (this.model) this.model.traverse((o) => { if ((o as THREE.Light).isLight) found.push(o as THREE.Light); });
    return found;
  }

  getLightInfo() {
    return {
      count: (this._modelLights ?? []).length,
      mode: this._lightMode ?? 'studio',
    };
  }

  setLightMode(mode: 'studio' | 'file' | 'none') {
    const own = this._modelLights ?? [];
    if (mode === 'file' && !own.length) return false;
    const studio = mode === 'studio';
    this._key.visible = studio;
    for (const l of own) l.visible = mode === 'file';
    this.scene.environmentIntensity = mode === 'studio' ? 1 : mode === 'file' ? FILE_MODE_ENV : 0;
    this._lightMode = mode;
    return true;
  }

  getVariantInfo() {
    const names = this._variants || [];
    return { count: names.length, names: [...names], current: this._variant ?? null };
  }

  async setVariant(name: string | null) {
    if (!this.model || !this._selectVariant) return false;
    if (name !== null && !(this._variants || []).includes(name)) return false;
    await this._selectVariant(this.model, name);
    this._variant = name;
    return true;
  }

  getAnimationInfo() {
    if (!this.clips || !this.clips.length) return { count: 0, names: [], index: -1, duration: 0 };
    return {
      count: this.clips.length,
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

  renderFrame() {
    this._advanceBehaviourAnimations();
    this._interactiveMarks?.sync();
    if (this.controls.enabled) this.controls.update();
    if (this._display === 'clay') this._updateClayDepth();
    if (this._display === 'texdiff') this._догнатьРазмещение();
    this.renderer.render(this.scene, this._activeCamera());
  }

  async snapshot({ width, height, background = null }: {
    width?: number; height?: number; background?: string | null;
  } = {}): Promise<{ blob: Blob; width: number; height: number } | null> {
    if (!this.model) return null;

    const было = new THREE.Vector2();
    this.renderer.getSize(было);
    const прежнийМасштаб = this.renderer.getPixelRatio();

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
      this.renderer.setPixelRatio(прежнийМасштаб);
      this._onResize();
      this.renderFrame();
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    return blob ? { blob, width: w, height: h } : null;
  }

  getCameraState(): CameraState {
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

  applyCameraState(state: CameraState | null) {
    if (!state) return;
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.controls.target.set(state.target.x, state.target.y, state.target.z);
    if (Number.isFinite(state.near) && Number.isFinite(state.far)) {
      this.camera.near = state.near;
      this.camera.far = state.far;
      this.camera.updateProjectionMatrix();
    }
    if (Number.isFinite(state.minDistance)) this.controls.minDistance = state.minDistance;
    if (Number.isFinite(state.maxDistance)) this.controls.maxDistance = state.maxDistance;
    this.controls.update();
  }

  _disposeModel() {
    if (!this.model) return;
    this._disposeMixer();
    this._uv = null;
    this._lods = null;
    this._lod = null;
    this.setInteractivityMarks(false);
    this._interactive = [];
    this._interactiveAll = [];
    this._interactiveOff = new Set<number>();
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
    this._fileCameras = [];
    this._cameraIndex = null;
    this._clayBounds = null;
    this.scene.fog = null;
    this.controls.enabled = true;
    for (const [mesh, mat] of this._origMaterials) mesh.material = mat;
    this._origMaterials.clear();
    this.scene.remove(this.model);
    disposeSubtree(this.model);
    this.model = null;
  }

  dispose() {
    this._disposeModel();
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
    this._applyAspect();
    this.renderer.setSize(clientWidth, clientHeight, false);
  }
}
