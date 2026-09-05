export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraState {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
  minDistance: number;
  maxDistance: number;
}

export interface LoadOptions {
  onProgress?: ((event: ProgressEvent) => void) | undefined;
  camera?: CameraState | null;
  format?: string | null;
}

export interface PackEntry {
  path: string;
  file: File | Blob;
}

export interface ViewerStats {
  triangles: number;
  vertices: number;
  drawCalls: number;
  materials: number;
  textures: number;
}

export interface ViewerOpportunity {
  sharedMeshes: number;
  sharedNodes: number;
}

export interface ViewerDetection {
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
  instance: boolean;
  opportunity: ViewerOpportunity;
}

export interface AnimationInfo {
  count: number;
  names: string[];
  index: number;
  duration: number;
}

export interface LodInfo {
  count: number;
  source: 'extension' | 'names' | 'measured' | null;
  names: string[];
  triangles: number[];
  current: number | 'all' | null;
}

export interface VariantInfo {
  count: number;
  names: string[];
  current: string | null;
}

export interface LightInfo {
  count: number;
  mode: 'studio' | 'file' | 'none';
}

export interface CameraListInfo {
  count: number;
  names: string[];
  current: number | null;
}

export interface CameraChangeSource {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export const DISPLAY_MODES = ['wire', 'clay', 'file', 'texdiff'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export interface SnapshotOptions {
  width?: number;
  height?: number;
  background?: string | null;
}

export interface SnapshotResult {
  blob: Blob;
  width: number;
  height: number;
}

export type DiffReference = unknown;

export interface DiffEntry {
  dispose(): void;
}

export interface ViewerLike {
  load(url: string, options?: LoadOptions): Promise<unknown>;
  getStats(): ViewerStats | null;
  getDetection(): ViewerDetection | null;
  renderFrame(): void;
  frame(): void;
  getCameraState(): CameraState;
  applyCameraState(state: CameraState | null): void;
  controls: CameraChangeSource;
  setAnimationTime(seconds: number): void;
  playClip(index: number): void;
  getAnimationInfo(): AnimationInfo;
  getLodInfo(): LodInfo;
  setLod(index: number | 'all' | null): boolean;
  getCameraInfo(): CameraListInfo;
  setCamera(index: number | null): boolean;
  getInteractivityInfo(): { count: number; names: string[]; shown: boolean };
  setInteractivityMarks(on: boolean): boolean;
  getBehaviourInfo(): { playable: boolean; refusal: string[] };
  onInteractivePick?: ((part: { name: string; responded: boolean }) => void) | null;
  getLightInfo(): LightInfo;
  setLightMode(mode: 'studio' | 'file' | 'none'): boolean;
  getVariantInfo(): VariantInfo;
  setVariant(name: string | null): Promise<boolean>;
  setExposure(value: number): void;
  setDisplayMaterial(mode: DisplayMode): boolean;
  getDisplayMaterial(): DisplayMode;
  snapshot?(options?: SnapshotOptions): Promise<SnapshotResult | null>;
  hasTextures(): boolean;
  setAssetResolver?(resolve: ((url: string) => string | null) | null): void;
  setPackFiles?(paths: string[] | null): void;
  dispose(): void;


  setOnBusy?(fn: ((busy: boolean) => void) | null): void;
  densityRange?(): [number, number] | null;
  setDensityScale?(range: [number, number] | null): void;
  textureRefs?(): DiffReference[];
  setDiffReference?(refs: DiffReference[] | null): void;
  useDiffStore?(store: Map<string, DiffEntry>): void;
  diffScale?(): number | null;
}
