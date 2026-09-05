import { Viewer } from "./viewer.js";
import type { CameraState, DiffEntry, DiffReference, DisplayMode, PackEntry, SnapshotOptions, ViewerLike } from "./contract.js";
import { DISPLAY_MODES } from "./contract.js";

const VIEWERS: Record<string, (canvas: HTMLCanvasElement) => ViewerLike> = {
  threejs: (canvas) => new Viewer(canvas),
};

let wantedViewer = 'threejs';

function useViewer(id: string) {
  if (!id || id === wantedViewer) return wantedViewer;
  if (!VIEWERS[id]) {
    console.warn(`[viewer] Движок просит вьюпорт «${id}», а приложение везёт только: ${Object.keys(VIEWERS).join(', ')}. Остаюсь на «${wantedViewer}».`);
    return wantedViewer;
  }
  wantedViewer = id;
  return wantedViewer;
}

function createViewer(canvas: HTMLCanvasElement) {
  return VIEWERS[wantedViewer]!(canvas);
}

const PERF_WINDOW = 60;

function median(arr: ArrayLike<number>) {
  const s = Array.from(arr).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function normalizeAssetPath(raw: string) {
  let s = String(raw || "").split("\\").join("/");
  try { s = decodeURIComponent(s); } catch {  }
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  return s.toLowerCase();
}

class ViewportSlot {
  declare container: HTMLElement;
  declare canvas: HTMLCanvasElement | null;
  declare statusEl: HTMLElement | null;
  declare viewer: ViewerLike | null;
  declare _blobUrl: string | null;
  declare _packUrls: string[];
  declare _onBusy: ((busy: boolean) => void) | null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = container.querySelector<HTMLCanvasElement>(".viewer-canvas");
    this.statusEl = container.querySelector<HTMLElement>(".viewer-status");
    this.viewer = null;
    this._blobUrl = null;
    this._packUrls = [];
    this._onBusy = null;
  }

  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this._onBusy = typeof fn === 'function' ? fn : null;
    this._применитьOnBusy();
  }

  _применитьOnBusy() {
    this.viewer?.setOnBusy?.(this._onBusy);
  }

  _ensureViewer() {
    if (!this.viewer) {
      this.viewer = createViewer(this.canvas!);
      this._применитьOnBusy();
    }
    return this.viewer;
  }

  _setStatus(key: string | null, values?: UiParams) {
    if (!this.statusEl) return;
    this.statusEl.textContent = "";
    if (key) {
      const plate = document.createElement("span");
      plate.className = "viewer-status-plate";
      if (window.I18n) window.I18n.setText(plate, key, values);
      else plate.textContent = key;
      this.statusEl.appendChild(plate);
    }
    this.statusEl.classList.toggle("hidden", !key);
  }

  _revokeBlob() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  _revokePack() {
    for (const u of this._packUrls) URL.revokeObjectURL(u);
    this._packUrls = [];
    this.viewer?.setAssetResolver?.(null);
  }

  _installPack(viewer: ViewerLike, modelUrl: string, pack?: PackEntry[] | null) {
    this._revokePack();
    const missing = new Set<string>();
    if (!pack || !pack.length) return missing;
    if (typeof viewer.setAssetResolver !== "function") {
      console.warn("[viewer] Движок не умеет брать соседние файлы модели — пачка будет показана без них.");
      return missing;
    }

    const base = modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1);
    const byPath = new Map<string, string>();
    const byName = new Map<string, string | null>();
    for (const item of pack) {
      if (!item || !item.file) continue;
      const blobUrl = URL.createObjectURL(item.file);
      this._packUrls.push(blobUrl);
      const rel = normalizeAssetPath(item.path);
      byPath.set(rel, blobUrl);
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      byName.set(name, byName.has(name) ? null : blobUrl);
    }

    if (typeof viewer.setPackFiles === 'function') viewer.setPackFiles(pack.map((i) => String(i.path)));

    viewer.setAssetResolver((requested: string) => {
      if (requested === modelUrl || !base || !requested.startsWith(base)) return null;
      const rel = normalizeAssetPath(requested.slice(base.length));
      const hit = byPath.get(rel);
      if (hit) return hit;
      const byBase = byName.get(rel.slice(rel.lastIndexOf("/") + 1));
      if (byBase) return byBase;
      missing.add(rel);
      return null;
    });
    return missing;
  }

  async load(source: string | File | Blob, opts: { camera?: CameraState | null; pack?: PackEntry[] | null } = {}) {
    const format = source instanceof File
      ? (source.name.split('.').pop() || '').toLowerCase()
      : null;
    const viewer = this._ensureViewer();
    this._setStatus("viewer.status.loading");

    let url = source as string;
    if (source instanceof File || source instanceof Blob) {
      this._revokeBlob();
      url = this._blobUrl = URL.createObjectURL(source);
    }

    const missing = this._installPack(viewer, url, opts.pack);
    try {
      await viewer.load(url, {
        format,
        camera: opts.camera || null,
        onProgress: (e: ProgressEvent) => {
          if (e && e.lengthComputable) {
            this._setStatus("viewer.status.loadingPct", { pct: Math.round((e.loaded / e.total) * 100) });
          }
        },
      });
      this._setStatus(null);
    } catch (err) {
      console.error("Viewer failed to load model:", err);
      this._setStatus("viewer.status.unavailable");
      this._revokeBlob();
      if (missing.size) console.warn('[viewer] Пачка не дала файлов, которые запросил загрузчик:', [...missing].join(', '));
      return null;
    } finally {
      this._revokePack();
    }
    this._revokeBlob();
    if (missing.size) console.warn('[viewer] Пачка не дала файлов, которые запросил загрузчик:', [...missing].join(', '));
    return { stats: viewer.getStats(), detected: viewer.getDetection() };
  }

  renderFrame() {
    if (this.viewer) this.viewer.renderFrame();
  }

  showHint(key: string, values?: UiParams) {
    this._setStatus(key, values);
  }

  reset() {
    this._revokeBlob();
    this._revokePack();
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
    }
    if (this.canvas) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this._setStatus(null);
  }
}

class DualViewport {
  declare left: ViewportSlot | null;
  declare right: ViewportSlot | null;
  declare linked: boolean;
  declare _syncing: boolean;
  declare _rafId: number | null;
  declare _animPlaying: boolean;
  declare _animTime: number;
  declare _animClipIndex: number;
  declare _variantName: string | null;
  declare _lodIndex: number | 'all' | null;
  declare _cameraIndex: number | null;
  declare _lightMode: 'studio' | 'file' | 'none';
  declare _interactiveOn: boolean;
  declare _exposure: number;
  declare _display: DisplayMode;
  declare _diffRefs: DiffReference[] | null;
  declare _diffStore: Map<string, Map<string, DiffEntry>>;
  declare _diffKey: string | null;
  declare _origKey: string | null;
  declare _perf: { left: Float64Array; right: Float64Array; frame: Float64Array; i: number };
  declare _unlink?: (() => void) | null;
  declare _onLoaded?: (() => void) | null;

  constructor() {
    this._diffRefs = null;
    this._diffStore = new Map();
    this._diffKey = null;
    this.left = null;
    this.right = null;
    this.linked = true;
    this._syncing = false;
    this._rafId = null;
    this._animPlaying = true;
    this._animTime = 0;
    this._animClipIndex = 0;
    this._variantName = null;
    this._lodIndex = null;
    this._cameraIndex = null;
    this._lightMode = 'studio';
    this._interactiveOn = true;
    this._exposure = 1;
    this._perf = {
      left: new Float64Array(PERF_WINDOW),
      right: new Float64Array(PERF_WINDOW),
      frame: new Float64Array(PERF_WINDOW),
      i: 0,
    };
  }

  _resetPerf() {
    this._perf.i = 0;
  }

  _init() {
    if (this.left && this.right) return true;
    const leftEl = document.getElementById("preview-original");
    const rightEl = document.getElementById("preview-optimized");
    if (!leftEl || !rightEl) return false;
    this.left = new ViewportSlot(leftEl);
    this.right = new ViewportSlot(rightEl);
    if (this._onBusy) for (const слот of [this.left, this.right]) слот.setOnBusy(this._onBusy);
    return true;
  }

  _linkCameras() {
    this._unlinkCameras();
    if (!this.left!.viewer || !this.right!.viewer) return;

    const sync = (from: ViewerLike, to: ViewerLike) => {
      if (this._syncing || !this.linked) return;
      this._syncing = true;
      to.applyCameraState(from.getCameraState());
      this._syncing = false;
    };
    const onLeftChange = () => sync(this.left!.viewer!, this.right!.viewer!);
    const onRightChange = () => sync(this.right!.viewer!, this.left!.viewer!);

    this.left!.viewer.controls.addEventListener("change", onLeftChange);
    this.right!.viewer.controls.addEventListener("change", onRightChange);
    this._unlink = () => {
      this.left!.viewer?.controls.removeEventListener("change", onLeftChange);
      this.right!.viewer?.controls.removeEventListener("change", onRightChange);
    };
  }

  _unlinkCameras() {
    if (this._unlink) {
      this._unlink();
      this._unlink = null;
    }
  }

  _startLoop() {
    if (this._rafId != null) return;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;
      this._advanceAnimation(dt);
      const t0 = performance.now();
      this.left!.renderFrame();
      const t1 = performance.now();
      this.right!.renderFrame();
      const t2 = performance.now();
      this._pushPerf(t0, t1, t2, dt);
      this._rafId = requestAnimationFrame(tick);
    };
    prev = performance.now();
    this._rafId = requestAnimationFrame(tick);
  }


  _pushPerf(t0: number, t1: number, t2: number, dt: number) {
    const p = this._perf;
    p.left[p.i % PERF_WINDOW] = t1 - t0;
    p.right[p.i % PERF_WINDOW] = t2 - t1;
    p.frame[p.i % PERF_WINDOW] = dt * 1000;
    p.i++;
  }

  getPerf() {
    const p = this._perf;
    if (p.i < PERF_WINDOW) return null;
    return {
      leftMs: median(p.left),
      rightMs: median(p.right),
      fps: 1000 / Math.max(median(p.frame), 0.001),
    };
  }


  _advanceAnimation(dt: number) {
    if (this._animPlaying) this._animTime = (this._animTime || 0) + dt;
    const t = this._animTime || 0;
    this.left?.viewer?.setAnimationTime(t);
    this.right?.viewer?.setAnimationTime(t);
  }

  getAnimation() {
    const info = this.left?.viewer?.getAnimationInfo?.() || { count: 0, names: [], index: -1, duration: 0 };
    return {
      ...info,
      playing: !!this._animPlaying,
      time: this._animTime || 0,
      leftIndex: this.left?.viewer?.getAnimationInfo?.().index ?? -1,
      rightIndex: this.right?.viewer?.getAnimationInfo?.().index ?? -1,
    };
  }

  getVariants() {
    const info = this.left?.viewer?.getVariantInfo?.() || { count: 0, names: [], current: null };
    return { ...info, selected: this._variantName ?? null };
  }

  async selectVariant(name: string | null) {
    this._variantName = name;
    await Promise.all([
      this.left?.viewer?.setVariant?.(name),
      this.right?.viewer?.setVariant?.(name),
    ]);
  }

  getLods() {
    const info = this.left?.viewer?.getLodInfo?.()
      || { count: 0, source: null, names: [], triangles: [], current: null };
    return { ...info, selected: this._lodIndex ?? null };
  }

  selectLod(index: number | 'all' | null) {
    this._lodIndex = index;
    this.left?.viewer?.setLod?.(index);
    this.right?.viewer?.setLod?.(index);
  }

  getInteractivity() {
    const info = this.left?.viewer?.getInteractivityInfo?.()
      || { count: 0, names: [] as string[], shown: false };
    const behaviour = this.left?.viewer?.getBehaviourInfo?.() || { playable: false, refusal: [] };
    return { ...info, shown: info.shown, playable: behaviour.playable };
  }

  toggleInteractivity(on?: boolean) {
    const next = on === undefined ? !this._interactiveOn : on;
    this._interactiveOn = next;
    this.left?.viewer?.setInteractivityMarks?.(next);
    this.right?.viewer?.setInteractivityMarks?.(next);
    return next;
  }

  getLight() {
    const info = this.left?.viewer?.getLightInfo?.() || { count: 0, mode: this._lightMode };
    return {
      ...info,
      leftMode: this.left?.viewer?.getLightInfo?.().mode ?? null,
      rightMode: this.right?.viewer?.getLightInfo?.().mode ?? null,
    };
  }

  selectLightMode(mode: 'studio' | 'file' | 'none') {
    this._lightMode = mode;
    this.left?.viewer?.setLightMode?.(mode);
    this.right?.viewer?.setLightMode?.(mode);
  }

  getCameras() {
    const info = this.left?.viewer?.getCameraInfo?.() || { count: 0, names: [], current: null };
    return {
      ...info,
      leftCurrent: this.left?.viewer?.getCameraInfo?.().current ?? null,
      rightCurrent: this.right?.viewer?.getCameraInfo?.().current ?? null,
    };
  }

  selectCamera(index: number | null) {
    this._cameraIndex = index;
    this.left?.viewer?.setCamera?.(index);
    this.right?.viewer?.setCamera?.(index);
  }

  setAnimationPlaying(playing: boolean) {
    this._animPlaying = !!playing;
  }

  seekAnimation(seconds: number) {
    this._animTime = Math.max(0, Number(seconds) || 0);
    this._advanceAnimation(0);
  }

  selectAnimationClip(index: number) {
    this._animClipIndex = Math.max(0, Number(index) || 0);
    this.left?.viewer?.playClip?.(this._animClipIndex);
    this.right?.viewer?.playClip?.(this._animClipIndex);
    this._animTime = 0;
    this._advanceAnimation(0);
  }


  setExposure(value: number) {
    const v = Number(value);
    this._exposure = Number.isFinite(v) ? Math.max(0.05, Math.min(v, 4)) : 1;
    this._applyExposure();
  }

  getExposure() {
    return this._exposure ?? 1;
  }

  _applyExposure() {
    const v = this._exposure ?? 1;
    this.left?.viewer?.setExposure?.(v);
    this.right?.viewer?.setExposure?.(v);
  }

  setDisplayMaterial(mode: DisplayMode) {
    this._display = DISPLAY_MODES.includes(mode) ? mode : 'file';
    this._applyDisplayMaterial();
  }

  getDisplayMaterial() {
    return this._display || 'file';
  }

  canSnapshot() {
    return typeof this.right?.viewer?.snapshot === 'function' && !!this.right?.viewer?.getStats?.();
  }

  async snapshotOptimized(options?: SnapshotOptions) {
    const viewer = this.right?.viewer;
    if (!viewer || typeof viewer.snapshot !== 'function') return null;
    return viewer.snapshot(options);
  }

  _applyDisplayMaterial() {
    const mode = this._display || 'file';
    const левый = this.left?.viewer;
    const правый = this.right?.viewer;
    if (mode === 'texdiff') {
      if (!this._diffRefs) this._diffRefs = левый?.textureRefs?.() || [];

      if (!this._diffKey) {
        правый?.useDiffStore?.(new Map());
      } else {
        let своя = this._diffStore.get(this._diffKey);
        if (!своя) {
          своя = new Map();
          if (this._diffStore.size >= 3) {
            const старейший = this._diffStore.keys().next().value as string | undefined;
            if (старейший) {
              for (const я of this._diffStore.get(старейший)!.values()) я.dispose();
              this._diffStore.delete(старейший);
            }
          }
          this._diffStore.set(this._diffKey, своя);
        }
        правый?.useDiffStore?.(своя);
      }

      правый?.setDiffReference?.(this._diffRefs);
    } else {
      правый?.setDiffReference?.(null);
    }
    if (mode === 'wire') {
      const диапазоны = [
        левый?.densityRange?.(),
        правый?.densityRange?.(),
      ].filter(Boolean) as Array<[number, number]>;
      const общая: [number, number] | null = диапазоны.length
        ? [Math.min(...диапазоны.map((d) => d[0])), Math.max(...диапазоны.map((d) => d[1]))]
        : null;
      for (const слот of [this.left, this.right]) {
        слот?.viewer?.setDensityScale?.(общая);
      }
    }

    this.left?.viewer?.setDisplayMaterial?.(mode === 'texdiff' ? 'file' : mode);
    this.right?.viewer?.setDisplayMaterial?.(mode);
  }

  _resetDisplayMaterial() {
    this._display = 'file';
    this._applyDisplayMaterial();
  }

  _stopLoop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  async loadOriginal(originalFile: File | null, pack?: PackEntry[] | null) {
    if (!this._init()) return null;
    this._diffRefs = null;
    this._origKey = originalFile ? `${originalFile.name}:${originalFile.size}:${originalFile.lastModified}` : null;
    this._diffKey = null;
    this._cameraIndex = null;
    this._lightMode = 'studio';
    this._unlinkCameras();
    this.right!.reset();
    this.right!.showHint("viewer.hint.compare");
    let info = null;
    if (originalFile) info = await this.left!.load(originalFile, { pack: pack || null });
    this._resetDisplayMaterial();
    this._afterLoad();
    return info;
  }

  async loadOptimized(optimizedUrl: string | null) {
    this._diffRefs = null;
    if (this._display === 'texdiff') {
      this.right?.viewer?.setDiffReference?.(null);
    }
    this._diffKey = this._origKey && optimizedUrl ? `${this._origKey}|${optimizedUrl}` : null;
    if (!this._init()) return;
    if (optimizedUrl) {
      const camera = this.left!.viewer ? this.left!.viewer.getCameraState() : null;
      await this.right!.load(optimizedUrl, { camera });
    } else {
      this.right!.showHint("viewer.hint.noOutput");
    }
    this._afterLoad();
  }

  _afterLoad() {
    this._resetPerf();
    if (this.left!.viewer && this.right!.viewer) this._linkCameras();
    this._applyAnimSelection();
    this._applyVariantSelection();
    this._applyLodSelection();
    this._applyCameraSelection();
    this._applyLightSelection();
    this._applyInteractivity();
    if (this._onPick) this.setOnInteractivePick(this._onPick);
    this._applyExposure();
    this._applyDisplayMaterial();
    this._startLoop();
    this._notifyLoaded();
  }

  setOnInteractivePick(fn: ((part: { name: string; responded: boolean }) => void) | null) {
    this._onPick = fn;
    if (this.left?.viewer) this.left.viewer.onInteractivePick = fn;
    if (this.right?.viewer) this.right.viewer.onInteractivePick = fn;
  }

  declare _onPick?: ((part: { name: string; responded: boolean }) => void) | null;
  declare _onBusy?: ((busy: boolean) => void) | null;

  setOnLoaded(fn: (() => void) | null) {
    this._onLoaded = typeof fn === 'function' ? fn : null;
  }

  setOnBusy(fn: ((busy: boolean) => void) | null) {
    this._onBusy = typeof fn === 'function' ? fn : null;
    for (const слот of [this.left, this.right]) слот?.setOnBusy?.(this._onBusy);
  }

  _notifyLoaded() {
    const fn = this._onLoaded || window.onOptiViewerModelLoaded;
    if (typeof fn === 'function') fn();
  }

  _applyLodSelection() {
    const index = this._lodIndex;
    if (index === null) return;
    this.left?.viewer?.setLod?.(index);
    this.right?.viewer?.setLod?.(index);
  }

  _applyCameraSelection() {
    const index = this._cameraIndex;
    if (index === null) return;
    const okLeft = this.left?.viewer ? this.left.viewer.setCamera(index) : true;
    const okRight = this.right?.viewer ? this.right.viewer.setCamera(index) : true;
    if (okLeft && okRight) return;
    this._cameraIndex = null;
    this.left?.viewer?.setCamera?.(null);
    this.right?.viewer?.setCamera?.(null);
  }

  _applyInteractivity() {
    if (this._interactiveOn) return;
    this.left?.viewer?.setInteractivityMarks?.(false);
    this.right?.viewer?.setInteractivityMarks?.(false);
  }

  _applyLightSelection() {
    const mode = this._lightMode;
    if (mode === 'studio') return;
    const okLeft = this.left?.viewer ? this.left.viewer.setLightMode(mode) : true;
    const okRight = this.right?.viewer ? this.right.viewer.setLightMode(mode) : true;
    if (okLeft && okRight) return;
    this._lightMode = 'studio';
    this.left?.viewer?.setLightMode?.('studio');
    this.right?.viewer?.setLightMode?.('studio');
  }

  _applyVariantSelection() {
    const name = this._variantName;
    if (name === null) return;
    void Promise.all([
      this.left?.viewer?.setVariant?.(name),
      this.right?.viewer?.setVariant?.(name),
    ]);
  }

  _applyAnimSelection() {
    const idx = this._animClipIndex || 0;
    if (idx > 0) {
      this.left?.viewer?.playClip?.(idx);
      this.right?.viewer?.playClip?.(idx);
    }
    this._advanceAnimation(0);
  }

  resetView() {
    const source = this.left?.viewer || this.right?.viewer;
    if (!source) return;
    source.frame();
    const state = source.getCameraState();
    if (this.left?.viewer && this.left.viewer !== source) this.left.viewer.applyCameraState(state);
    if (this.right?.viewer && this.right.viewer !== source) this.right.viewer.applyCameraState(state);
  }

  cameraStates() {
    return {
      left: this.left && this.left.viewer ? this.left.viewer.getCameraState() : null,
      right: this.right && this.right.viewer ? this.right.viewer.getCameraState() : null,
    };
  }

  setLinked(on: boolean) {
    this.linked = !!on;
  }

  reset() {
    this._stopLoop();
    this._resetPerf();
    this._unlinkCameras();
    if (this.left) this.left.reset();
    if (this.right) this.right.reset();
    this._notifyLoaded();
  }
}

const dual = new DualViewport();

window.OptiViewer = {
  implementations: () => Object.keys(VIEWERS),
  useViewer: (id) => useViewer(id),
  currentViewer: () => wantedViewer,
  loadOriginal: (file, pack) => dual.loadOriginal(file, pack as PackEntry[] | null),
  assetKey: (p) => normalizeAssetPath(p),
  loadOptimized: (url) => dual.loadOptimized(url),
  resetView: () => dual.resetView(),
  setLinked: (on) => dual.setLinked(on),
  reset: () => dual.reset(),
  cameraStates: () => dual.cameraStates(),
  getAnimation: () => dual.getAnimation(),
  setAnimationPlaying: (on) => dual.setAnimationPlaying(on),
  seekAnimation: (sec) => dual.seekAnimation(sec),
  selectAnimationClip: (i) => dual.selectAnimationClip(i),
  getLods: () => dual.getLods(),
  selectLod: (index) => dual.selectLod(index),
  getVariants: () => dual.getVariants(),
  selectVariant: (name) => dual.selectVariant(name),
  getLight: () => dual.getLight(),
  selectLightMode: (mode) => dual.selectLightMode(mode),
  getInteractivity: () => dual.getInteractivity(),
  toggleInteractivity: (on) => dual.toggleInteractivity(on),
  getCameras: () => dual.getCameras(),
  selectCamera: (index) => dual.selectCamera(index),
  setExposure: (v) => dual.setExposure(v),
  setDisplayMaterial: (mode) => dual.setDisplayMaterial(mode),
  diffScale: () => dual.right?.viewer?.diffScale?.() ?? null,
  getDisplayMaterial: () => dual.getDisplayMaterial(),
  snapshot: (options) => dual.snapshotOptimized(options),
  canSnapshot: () => dual.canSnapshot(),
  getExposure: () => dual.getExposure(),
  getPerf: () => dual.getPerf(),
  setOnLoaded: (fn) => dual.setOnLoaded(fn),
  setOnBusy: (fn) => dual.setOnBusy(fn),
  setOnInteractivePick: (fn) => dual.setOnInteractivePick(fn),
};

window.onOptiViewerReady?.();
