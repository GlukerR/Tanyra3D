type UiMessage = string | ((params: Record<string, unknown>) => string);

type UiCatalog = Record<string, UiMessage>;

type UiParams = Record<string, unknown>;

interface I18nApi {
  t(key: string, params?: UiParams): string;
  plural(n: number, forms: string[]): string;
  apply(root?: ParentNode | null): void;
  setLang(next: string): void;
  setText(el: Element | null, key: string, values?: UiParams): void;
  setTitle(el: Element | null, key: string, values?: UiParams): void;
  setAria(el: Element | null, key: string, values?: UiParams): void;
  setRaw(el: Element | null, text: string): void;
  readonly lang: string;
  languages(): string[];
  onChange(fn: (lang: string) => void): void;
}

interface OptiViewerApi {
  implementations(): string[];
  useViewer(id: string): void;
  currentViewer(): string;
  loadOriginal(file: File, pack?: Array<{ path: string; file: File | Blob }> | null): Promise<unknown>;
  assetKey(path: string): string;
  loadOptimized(url: string): Promise<unknown>;
  resetView(): void;
  setLinked(on: boolean): void;
  reset(): void;
  cameraStates(): unknown;
  getAnimation(): {
    count: number;
    names: string[];
    index: number;
    duration: number;
    playing: boolean;
    time: number;
    [key: string]: any;
  };
  setAnimationPlaying(on: boolean): void;
  seekAnimation(sec: number): void;
  selectAnimationClip(i: number): void;
  getLods(): {
    count: number;
    source: 'extension' | 'names' | 'measured' | null;
    names: string[];
    triangles: number[];
    current: number | 'all' | null;
    selected: number | 'all' | null;
  };
  selectLod(index: number | 'all' | null): void;
  getVariants(): { count: number; names: string[]; current: string | null; selected: string | null };
  selectVariant(name: string | null): Promise<void>;
  getLight(): { count: number; mode: 'studio' | 'file' | 'none' };
  getInteractivity(): { count: number; names: string[]; shown: boolean; playable: boolean };
  setOnInteractivePick(fn: ((part: { name: string; responded: boolean }) => void) | null): void;
  toggleInteractivity(on?: boolean): boolean;
  selectLightMode(mode: 'studio' | 'file' | 'none'): void;
  getCameras(): { count: number; names: string[]; current: number | null };
  selectCamera(index: number | null): void;
  setExposure(v: number): void;
  getExposure(): number;
  setDisplayMaterial(mode: 'wire' | 'clay' | 'file' | 'texdiff'): void;
  diffScale(): number | null;
  getDisplayMaterial(): 'wire' | 'clay' | 'file' | 'texdiff';
  snapshot(options?: { width?: number; height?: number; background?: string | null }):
    Promise<{ blob: Blob; width: number; height: number } | null>;
  canSnapshot(): boolean;
  getPerf(): { leftMs?: number; rightMs?: number; fps?: number } | null;
  setOnLoaded(fn: () => void): void;
  setOnBusy(fn: (busy: boolean) => void): void;
}

interface Window {
  I18N_CATALOGS?: Record<string, UiCatalog>;
  I18n: I18nApi;
  OptiViewer: OptiViewerApi;
  onOptiViewerModelLoaded?: () => void;
  onOptiViewerReady?: () => void;
}

interface Element {
  __i18n?: Record<string, UiParams | undefined>;
}
