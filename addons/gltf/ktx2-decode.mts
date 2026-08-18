// Распаковка KTX2 обратно в пиксели — чтобы «уже формат для видеокарты» перестало быть
// причиной отказа.
//
// Повод (Александр, 2026-08-17): «галочка есть? есть! значит мы всегда меняем. никаких
// алреди гпу». До этого правило textures/webp обходило KTX2-текстуры стороной, и человек,
// выбравший WebP, получал в результате KHR_texture_basisu и ни слова объяснения.
//
// Откуда декодер. Транскодер Basis уже лежит в three (его грузит наш же вьюпорт в
// браузере через KTX2Loader) — новых зависимостей не нужно, и в собранном приложении он
// тоже на месте: electron-builder копирует three/examples/jsm через extraResources
// (см. _comment_three_examples в package.json).
//
// ЧЕГО ЭТА РАСПАКОВКА СТОИТ, и это надо говорить вслух:
//   1. Basis сжимает С ПОТЕРЯМИ. Распаковали и закодировали в WebP — потери сложились
//      дважды. Обратно в исходное качество текстура не вернётся никогда.
//   2. KTX2 везёт готовую пирамиду уровней (у замеренной текстуры их 12). WebP хранит
//      одну картинку; уровни движок пересчитает сам при загрузке.
//   3. Видеопамять ВЫРАСТЕТ: KTX2 остаётся сжатым на видеокарте, WebP — нет.
// Ни одно из трёх не повод отказаться (решает человек), но всё три обязаны попасть
// в отчёт — иначе замер, ради которого он это включил, будет враньём.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Распакованная картинка: сырые пиксели плюс размеры, как их ждёт sharp. */
export interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** Сколько уровней несла исходная пирамида — для честной строки в отчёте. */
  levels: number;
}

/** cTFRGBA32 из перечисления transcoder_texture_format — обычные пиксели, не формат GPU. */
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

/**
 * Поднимает транскодер один раз на процесс. WASM весит полмегабайта и инициализируется
 * заметное время — грузим лениво, тем же приёмом, что и sharp в правилах.
 */
function loadBasis(): Promise<BasisModule> {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    // Резолвим через require.resolve, а не склейкой путей: в собранном приложении
    // node_modules лежит не там, где в дереве разработки, и жёсткий путь бы разошёлся.
    const jsPath = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js');
    const dir = path.dirname(jsPath);
    const wasmBinary = fs.readFileSync(path.join(dir, 'basis_transcoder.wasm'));

    // Два подводных камня упаковки, оба уже стоили времени при проверке:
    //   1. import/require не годятся — у three в package.json стоит "type": "module",
    //      файл читается как ESM, и его ветка `module.exports = BASIS` не срабатывает;
    //      наружу не выходит ничего.
    //   2. new Function() тоже не годится — внутри emscripten-кода есть require("fs")
    //      и __dirname, которых в той области нет.
    // Файл написан под обычный script — так и выполняем, подсунув ему окружение CommonJS.
    const src = fs.readFileSync(jsPath, 'utf8');
    const factory = vm.runInThisContext(
      `(function (require, __dirname, __filename, module, exports) { ${src}; return BASIS; })`,
      { filename: jsPath },
    ) as (...a: unknown[]) => (cfg: unknown) => Promise<BasisModule>;

    const mod = await factory(require, dir, jsPath, {}, {})({ wasmBinary });
    mod.initializeBasis();
    return mod;
  })();
  // Сорвавшуюся инициализацию не держим в кэше: разовый сбой иначе делал бы распаковку
  // невозможной до конца процесса. Тот же приём, что у createIO в index.mts.
  _modulePromise.catch(() => { _modulePromise = null; });
  return _modulePromise;
}

/**
 * KTX2 → пиксели RGBA. Возвращает null, если распаковать нечем или незачем; причину
 * кладёт в reason, чтобы правило написало в отчёт не «не смогли», а что именно.
 */
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
    // HDR-текстуры в RGBA32 не разворачиваются: там значения за пределами 0..255, и
    // приведение к байтам — не распаковка, а порча. Отказ честнее подмены.
    if (file.isHDR()) return { image: null, reason: 'ktx2.hdr' };
    // Кубические карты и массивы слоёв в glTF-текстуре не встречаются, но проверить
    // дешевле, чем молча взять нулевую грань и выдать её за всю картинку.
    if (file.getFaces() > 1 || file.getLayers() > 1) return { image: null, reason: 'ktx2.multiface' };

    const width = file.getWidth();
    const height = file.getHeight();
    const levels = file.getLevels();
    if (!width || !height) return { image: null, reason: 'ktx2.empty' };
    if (!file.startTranscoding()) return { image: null, reason: 'ktx2.transcodeStart' };

    // Уровень 0 — самый крупный. Остальные не берём: WebP пирамиду не хранит.
    const size = file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32);
    const data = new Uint8Array(size);
    if (!file.transcodeImage(data, 0, 0, 0, RGBA32, 0, -1, -1)) {
      return { image: null, reason: 'ktx2.transcodeFailed' };
    }
    return { image: { data, width, height, levels } };
  } catch (e) {
    return { image: null, reason: (e as Error).message };
  } finally {
    // Память WASM сама не освобождается: без close/delete каждая текстура оставляла бы
    // за собой свой буфер, а на модели с двумя десятками текстур это уже сотни мегабайт.
    if (file) {
      try { file.close(); } catch { /* уже закрыт — не важно */ }
      try { file.delete(); } catch { /* уже удалён — не важно */ }
    }
  }
}
