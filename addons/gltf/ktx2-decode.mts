import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  levels: number;
}

const RGBA32 = 13;

interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => Ktx2File;
}

interface Ktx2File {
  isValid(): boolean;
  isHDR(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getFaces(): number;
  getLayers(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(
    dst: Uint8Array, level: number, layer: number, face: number, format: number,
    getAlphaForOpaqueFormats: number, channel0: number, channel1: number,
  ): boolean;
  close(): void;
  delete(): void;
}

let _modulePromise: Promise<BasisModule> | null = null;

function loadBasis(): Promise<BasisModule> {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    const jsPath = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js');
    const dir = path.dirname(jsPath);
    const wasmBinary = fs.readFileSync(path.join(dir, 'basis_transcoder.wasm'));

    const src = fs.readFileSync(jsPath, 'utf8');
    const factory = vm.runInThisContext(
      `(function (require, __dirname, __filename, module, exports) { ${src}; return BASIS; })`,
      { filename: jsPath },
    ) as (...a: unknown[]) => (cfg: unknown) => Promise<BasisModule>;

    const mod = await factory(require, dir, jsPath, {}, {})({ wasmBinary });
    mod.initializeBasis();
    return mod;
  })();
  _modulePromise.catch(() => { _modulePromise = null; });
  return _modulePromise;
}

export async function decodeKtx2(
  payload: Uint8Array,
): Promise<{ image: DecodedImage | null; reason?: string }> {
  let mod: BasisModule;
  try {
    mod = await loadBasis();
  } catch (e) {
    return { image: null, reason: (e as Error).message };
  }

  let file: Ktx2File | null = null;
  try {
    file = new mod.KTX2File(payload);
    if (!file.isValid()) return { image: null, reason: 'ktx2.invalid' };
    if (file.isHDR()) return { image: null, reason: 'ktx2.hdr' };
    if (file.getFaces() > 1 || file.getLayers() > 1) return { image: null, reason: 'ktx2.multiface' };

    const width = file.getWidth();
    const height = file.getHeight();
    const levels = file.getLevels();
    if (!width || !height) return { image: null, reason: 'ktx2.empty' };
    if (!file.startTranscoding()) return { image: null, reason: 'ktx2.transcodeStart' };

    const size = file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32);
    const data = new Uint8Array(size);
    if (!file.transcodeImage(data, 0, 0, 0, RGBA32, 0, -1, -1)) {
      return { image: null, reason: 'ktx2.transcodeFailed' };
    }
    return { image: { data, width, height, levels } };
  } catch (e) {
    return { image: null, reason: (e as Error).message };
  } finally {
    if (file) {
      try { file.close(); } catch {  }
      try { file.delete(); } catch {  }
    }
  }
}
