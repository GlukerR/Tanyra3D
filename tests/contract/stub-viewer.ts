import type {
  AnimationInfo,
  CameraChangeSource,
  CameraListInfo,
  CameraState,
  DiffEntry,
  DiffReference,
  DisplayMode,
  LightInfo,
  LoadOptions,
  LodInfo,
  SnapshotOptions,
  SnapshotResult,
  VariantInfo,
  ViewerDetection,
  ViewerLike,
  ViewerStats,
} from '../../ui/viewer/contract.js';

class Слушатели implements CameraChangeSource {
  private readonly кто = new Set<() => void>();

  addEventListener(_type: 'change', listener: () => void) {
    this.кто.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void) {
    this.кто.delete(listener);
  }

  сказать() {
    for (const f of this.кто) f();
  }
}

export class StubViewer implements ViewerLike {
  readonly controls = new Слушатели();

  onInteractivePick: ((part: { name: string; responded: boolean }) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private камера: CameraState = {
    position: { x: 0, y: 0, z: 1 },
    target: { x: 0, y: 0, z: 0 },
    near: 0.01,
    far: 100,
    minDistance: 0.1,
    maxDistance: 50,
  };
  private режим: DisplayMode = 'file';
  private загружено = false;
  private время = 0;
  private экспозиция = 1;
  private свет: LightInfo['mode'] = 'studio';
  private память: Map<string, DiffEntry> | null = null;
  private занят: ((busy: boolean) => void) | null = null;
  private поискФайла: ((url: string) => string | null) | null = null;
  private пачка: string[] | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async load(_url: string, options?: LoadOptions) {
    this.загружено = true;
    if (options?.camera) this.applyCameraState(options.camera);
    return null;
  }

  getStats(): ViewerStats | null {
    if (!this.загружено) return null;
    return { triangles: 0, vertices: 0, drawCalls: 0, materials: 0, textures: 0 };
  }

  getDetection(): ViewerDetection | null {
    if (!this.загружено) return null;
    return {
      draco: false,
      meshopt: false,
      ktx2: false,
      instance: false,
      opportunity: { sharedMeshes: 0, sharedNodes: 0 },
    };
  }

  renderFrame() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = this.режим === 'wire' ? '#202028' : '#181820';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  frame() {
    this.камера = { ...this.камера, position: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 0, z: 0 } };
    this.controls.сказать();
  }

  getCameraState(): CameraState {
    return {
      position: { ...this.камера.position },
      target: { ...this.камера.target },
      near: this.камера.near,
      far: this.камера.far,
      minDistance: this.камера.minDistance,
      maxDistance: this.камера.maxDistance,
    };
  }

  applyCameraState(state: CameraState | null) {
    if (!state) return;
    this.камера = {
      position: { ...state.position },
      target: { ...state.target },
      near: state.near,
      far: state.far,
      minDistance: state.minDistance,
      maxDistance: state.maxDistance,
    };
  }

  setAnimationTime(seconds: number) {
    this.время = seconds;
  }

  playClip(_index: number) {
  }

  getAnimationInfo(): AnimationInfo {
    return { count: 0, names: [], index: 0, duration: this.время * 0 };
  }

  getLodInfo(): LodInfo {
    return { count: 0, source: null, names: [], triangles: [], current: null };
  }

  setLod(_index: number | 'all' | null) {
    return false;
  }

  getCameraInfo(): CameraListInfo {
    return { count: 0, names: [], current: null };
  }

  setCamera(_index: number | null) {
    return false;
  }

  getInteractivityInfo() {
    return { count: 0, names: [] as string[], shown: false };
  }

  setInteractivityMarks(_on: boolean) {
    return false;
  }

  getBehaviourInfo() {
    return { playable: false, refusal: [] as string[] };
  }

  getLightInfo(): LightInfo {
    return { count: 0, mode: this.свет };
  }

  setLightMode(mode: LightInfo['mode']) {
    if (mode === 'file') return false;
    this.свет = mode;
    return true;
  }

  getVariantInfo(): VariantInfo {
    return { count: 0, names: [], current: null };
  }

  async setVariant(_name: string | null) {
    return false;
  }

  setExposure(value: number) {
    this.экспозиция = value;
  }

  setDisplayMaterial(mode: DisplayMode) {
    this.режим = mode;
    return true;
  }

  getDisplayMaterial(): DisplayMode {
    return this.режим;
  }

  hasTextures() {
    return false;
  }

  async snapshot(options?: SnapshotOptions): Promise<SnapshotResult | null> {
    const w = options?.width ?? this.canvas.width;
    const h = options?.height ?? this.canvas.height;
    this.renderFrame();
    const blob = await new Promise<Blob | null>((готово) => this.canvas.toBlob(готово, 'image/png'));
    return blob ? { blob, width: w, height: h } : null;
  }

  setAssetResolver(resolve: ((url: string) => string | null) | null) {
    this.поискФайла = resolve;
  }

  setPackFiles(paths: string[] | null) {
    this.пачка = paths ? [...paths] : null;
  }


  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this.занят = typeof fn === 'function' ? fn : null;
  }

  densityRange(): [number, number] | null {
    return null;
  }

  setDensityScale(_range: [number, number] | null) {
  }

  textureRefs(): DiffReference[] {
    return [];
  }

  setDiffReference(_refs: DiffReference[] | null) {
  }

  useDiffStore(store: Map<string, DiffEntry>) {
    this.память = store;
  }

  diffScale(): number | null {
    return null;
  }

  dispose() {
    this.загружено = false;
    this.память = null;
    this.поискФайла = null;
    this.пачка = null;
    this.занят?.(false);
    this.занят = null;
    void this.экспозиция;
    void this.время;
  }
}
