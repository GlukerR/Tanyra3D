import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { RULES } from '../addons/gltf/rules.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath, itIfModel } from './helpers/model-files.mjs';

const parses = vi.hoisted(() => ({ n: 0 }));
vi.mock('sharp', async (importOriginal) => {
  const actual = (await importOriginal()).default;
  const counted = (...args) => {
    const pipeline = actual(...args);
    const stats = pipeline.stats.bind(pipeline);
    pipeline.stats = (...rest) => { parses.n += 1; return stats(...rest); };
    return pipeline;
  };
  Object.assign(counted, actual);
  return { default: counted };
});

const ioPromise = gltfAddon.createIO();
const rule = RULES.find((r) => r.meta.id === 'textures/flat');
const ctxFor = (document) => ({
  document,
  opts: { locale: 'ru', safe: true },
  log: () => {},
  dstName: 'flat-probe.glb',
});

async function docWithImages(model, images) {
  const io = await ioPromise;
  const doc = await io.read(modelPath(model));
  const texs = doc.getRoot().listTextures();
  for (let i = 0; i < texs.length; i++) {
    const img = images[i] || await noisy(64, 64);
    texs[i].setImage(new Uint8Array(img)).setMimeType('image/png');
  }
  return doc;
}

const flat = (w, h, rgb) => sharp({
  create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
}).png().toBuffer();

async function noisy(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + (i % 13) * 91) % 256;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('textures/flat — заливка одним цветом ужимается до пикселя', () => {
  it('находит и крупную заливку, и мелкую', async () => {
    const doc = await docWithImages('Dirty Cube 01.glb', [
      await flat(2048, 2048, [128, 128, 255]),
      await flat(4, 4, [0, 0, 0]),
    ]);
    parses.n = 0;
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found).toHaveLength(1);
    expect(out.found[0].messageId).toBe('flat.found');
    expect(out.found[0].data.n).toBe(2);

    expect(parses.n, 'счётчик разборов не считает — перехват sharp не встал').toBeGreaterThan(0);
  }, 120000);

  it('ГРАНИЦА: заливка в лоссовом WebP не находится — и это записано, а не забыто', async () => {
    const solid = { create: { width: 128, height: 128, channels: 3, background: { r: 50, g: 60, b: 70 } } };
    const lossy = await sharp(solid).webp({ quality: 90 }).toBuffer();
    const doc = await docWithImages('Dirty Cube 01.glb', [lossy]);
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found, 'если это упало — лоссовые заливки стали находиться, обновить границу').toHaveLength(0);

    const clean = await docWithImages('Dirty Cube 01.glb', [await sharp(solid).webp({ lossless: true }).toBuffer()]);
    const ok = await rule.fix({}, ctxFor(clean));
    expect(ok.found).toHaveLength(1);
  }, 120000);

  it('битую картинку не выдаёт за «не заливку» — сбой попадает в «Пропущено»', async () => {
    const broken = Buffer.from('это не картинка, а просто байты', 'utf8');
    const doc = await docWithImages('Dirty Cube 01.glb', [broken]);
    const out = await rule.fix({}, ctxFor(doc));

    const said = out.skipped.find((s) => s.messageId === 'flat.skipped.failed');
    expect(said, 'сбой разбора обязан попасть в отчёт, а не потеряться').toBeTruthy();
    expect(said.data.n).toBe(1);
    expect(Buffer.from(doc.getRoot().listTextures()[0].getImage())).toEqual(broken);
  }, 120000);

  it('сбой доезжает до отчёта, даже когда заливок не нашлось вовсе', async () => {
    const doc = await docWithImages('Dirty Cube 01.glb', [
      Buffer.from('битые байты', 'utf8'),
      await noisy(64, 64),
    ]);
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found).toHaveLength(0);
    expect(out.skipped.find((s) => s.messageId === 'flat.skipped.failed')).toBeTruthy();
  }, 120000);

  it('настоящую картинку не трогает', async () => {
    const before = await noisy(256, 256);
    const doc = await docWithImages('Dirty Cube 01.glb', [before]);
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found).toHaveLength(0);
    expect(Buffer.from(doc.getRoot().listTextures()[0].getImage())).toEqual(Buffer.from(before));
  }, 120000);

  it('цвет сохраняется побайтно, а размер становится одним пикселем', async () => {
    const colour = [149, 149, 149];
    const doc = await docWithImages('Dirty Cube 01.glb', [await flat(2048, 2048, colour)]);
    await rule.fix({}, ctxFor(doc));

    const after = Buffer.from(doc.getRoot().listTextures()[0].getImage());
    const meta = await sharp(after).metadata();
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    const px = await sharp(after).raw().toBuffer();
    expect([px[0], px[1], px[2]]).toEqual(colour);
  }, 120000);

  it('отчёт называет видеопамять, а не файл', async () => {
    const doc = await docWithImages('Dirty Cube 01.glb', [await flat(2048, 2048, [0, 0, 0])]);
    const out = await rule.fix({}, ctxFor(doc));
    const done = out.details.find((d) => d.messageId === 'flat.done');
    expect(done).toBeTruthy();
    expect(done.data.vramMb).toBeGreaterThan(10);
  }, 120000);

  itIfModel('ABeautifulGame.glb', 'разбор пикселей не запускается на настоящих текстурах — иначе правило стоило бы секунд', async () => {
    const io = await ioPromise;
    const doc = await io.read(modelPath('ABeautifulGame.glb'));
    const textures = doc.getRoot().listTextures();

    parses.n = 0;
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found).toHaveLength(0);

    expect(
      parses.n,
      `правило развернуло ${parses.n} картинок из ${textures.length}; `
        + 'настоящие текстуры обязаны отсеиваться по заголовку, без разбора пикселей',
    ).toBe(0);
  }, 120000);
});
