// tests/flat-textures.test.mjs — правило textures/flat: заливка одним цветом → один пиксель.
//
// Мысль Александра (2026-08-17): «текстуры полностью залитые одним цветом должны ужиматься
// максимально сразу. например полностью чёрный или полностью синяя нормалмапа».
//
// Правило проверяется по трём осям, и каждая закрывает найденный при разработке промах:
//
//   1. НАХОДИТ то, что должно, — и крупную заливку, и мелкую. Дешёвый отсев по весу на
//      пиксель (без него разбор 33 текстур стоил 2 с на каждом прогоне) едва не отбросил
//      мелкие: у картинки 4×4 служебные байты формата перевешивают сами пиксели.
//   2. НЕ ТРОГАЕТ настоящую картинку — иначе это было бы редактированием модели.
//   3. СОХРАНЯЕТ ЦВЕТ побайтно. Это единственное, чем правило оправдано перед Правилом 11:
//      разрешение заливки не замысел автора, а остаток экспорта, но сам цвет — замысел.
//
// Отдельно зафиксировано, ЧЕГО правило не даёт: на всём корпусе (250+ моделей) оно не
// срабатывает ни разу, потому что неиспользуемые заливки уносит structure/prune-unused
// задолго до него. Это страховка на случай ИСПОЛЬЗУЕМОЙ заливки, а не выигрыш здесь и
// сейчас, и тест говорит об этом прямо, чтобы следующая сессия не переоткрывала вопрос.

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { RULES } from '../addons/gltf/rules.mjs';
import gltfAddon from '../addons/gltf/index.mjs';
import { modelPath, itIfModel } from './helpers/model-files.mjs';

const ioPromise = gltfAddon.createIO();
const rule = RULES.find((r) => r.meta.id === 'textures/flat');
const ctxFor = (document) => ({
  document,
  opts: { locale: 'ru', safe: true },
  log: () => {},
  dstName: 'flat-probe.glb',
});

/**
 * Документ корпуса, у которого ВСЕ текстуры заменены: первые — заданными картинками,
 * остальные — шумом.
 *
 * Заменять все обязательно. `Dirty Cube 01` сам несёт чёрную заливку 1024×1024 (её и
 * нашёл разведочный зонд), и она попадала в счёт находок — тест падал, обвиняя правило
 * в том, чего оно не делало. Модель для подмены должна приносить только текстурные
 * СЛОТЫ, а их содержимое задаёт тест.
 */
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

/** Картинка, залитая одним цветом. */
const flat = (w, h, rgb) => sharp({
  create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
}).png().toBuffer();

/** Картинка с настоящим рисунком — шум, который не спутать с заливкой. */
async function noisy(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + (i % 13) * 91) % 256;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('textures/flat — заливка одним цветом ужимается до пикселя', () => {
  it('находит и крупную заливку, и мелкую', async () => {
    // 2048×2048 отсев по весу пропускает как явную заливку; 4×4 он обязан пропустить
    // к разбору БЕЗ проверки веса — иначе мелкие заливки терялись бы молча.
    const doc = await docWithImages('Dirty Cube 01.glb', [
      await flat(2048, 2048, [128, 128, 255]), // синяя нормаль: «рельефа нет»
      await flat(4, 4, [0, 0, 0]),
    ]);
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found).toHaveLength(1);
    expect(out.found[0].messageId).toBe('flat.found');
    expect(out.found[0].data.n).toBe(2);
  }, 120000);

  it('ГРАНИЦА: заливка в лоссовом WebP не находится — и это записано, а не забыто', async () => {
    // Найдено ревью 2026-08-18. Сравнение строгое (min === max), а лоссовый WebP слегка
    // «шевелит» ровное поле: сплошной RGB(50,60,70) после q90 читается как 50/52 · 59/60.
    // Тест закрепляет ГРАНИЦУ, а не желаемое поведение: пока он зелёный, дыра видна и
    // описана. Смягчение допуска — это выбор представительного цвета вместо настоящего,
    // то есть правка пикселей автора; такое решается разговором (Правило 11), а не в коде.
    const solid = { create: { width: 128, height: 128, channels: 3, background: { r: 50, g: 60, b: 70 } } };
    const lossy = await sharp(solid).webp({ quality: 90 }).toBuffer();
    const doc = await docWithImages('Dirty Cube 01.glb', [lossy]);
    const out = await rule.fix({}, ctxFor(doc));
    expect(out.found, 'если это упало — лоссовые заливки стали находиться, обновить границу').toHaveLength(0);

    // А те же байты без потерь находятся: значит дело именно в кодеке, а не в правиле.
    const clean = await docWithImages('Dirty Cube 01.glb', [await sharp(solid).webp({ lossless: true }).toBuffer()]);
    const ok = await rule.fix({}, ctxFor(clean));
    expect(ok.found).toHaveLength(1);
  }, 120000);

  it('битую картинку не выдаёт за «не заливку» — сбой попадает в «Пропущено»', async () => {
    // Правило 12 в чистом виде. Галочка safe стояла, разобрать текстуру не вышло, работа
    // не сделана — значит человек обязан узнать. Раньше проверка была одна на два разных
    // исхода (`if (!res.ok || !res.value) continue`), и битая текстура молча выпадала под
    // видом «это не заливка». Найдено ревью 2026-08-18.
    const broken = Buffer.from('это не картинка, а просто байты', 'utf8');
    const doc = await docWithImages('Dirty Cube 01.glb', [broken]);
    const out = await rule.fix({}, ctxFor(doc));

    const said = out.skipped.find((s) => s.messageId === 'flat.skipped.failed');
    expect(said, 'сбой разбора обязан попасть в отчёт, а не потеряться').toBeTruthy();
    expect(said.data.n).toBe(1);
    // и байты битой текстуры не тронуты — правило её не «починило» по дороге
    expect(Buffer.from(doc.getRoot().listTextures()[0].getImage())).toEqual(broken);
  }, 120000);

  it('сбой доезжает до отчёта, даже когда заливок не нашлось вовсе', async () => {
    // Отдельный случай, а не дубль предыдущего: строка о сбое стояла ПОСЛЕ раннего
    // выхода `if (!n) return out`, и на модели без единой заливки терялась целиком.
    const doc = await docWithImages('Dirty Cube 01.glb', [
      Buffer.from('битые байты', 'utf8'),
      await noisy(64, 64), // настоящая картинка — заливок в модели нет ни одной
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
    // и байты остались те же — правило вообще не прикасалось к картинке
    expect(Buffer.from(doc.getRoot().listTextures()[0].getImage())).toEqual(Buffer.from(before));
  }, 120000);

  it('цвет сохраняется побайтно, а размер становится одним пикселем', async () => {
    const colour = [149, 149, 149]; // тот самый серый из клиентских моделей
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
    // По файлу выигрыш копеечный: заливку кодек жмёт почти в ноль (2048×2048 → 33 КБ).
    // Вся польза в видеопамяти — там та же текстура занимает 21.3 МБ, потому что
    // видеокарта хранит пиксели распакованными. Без этой цифры строка бессмысленна.
    const doc = await docWithImages('Dirty Cube 01.glb', [await flat(2048, 2048, [0, 0, 0])]);
    const out = await rule.fix({}, ctxFor(doc));
    const done = out.details.find((d) => d.messageId === 'flat.done');
    expect(done).toBeTruthy();
    expect(done.data.vramMb).toBeGreaterThan(10);
  }, 120000);

  itIfModel('ABeautifulGame.glb', 'разбор пикселей не запускается на настоящих текстурах — иначе правило стоило бы секунд', async () => {
    // Сторож цены, а не скорости ради скорости: без отсева по заголовку каждый безопасный
    // прогон ABeautifulGame становился на 2 секунды длиннее ради нуля находок.
    const io = await ioPromise;
    const doc = await io.read(modelPath('ABeautifulGame.glb'));
    const t0 = Date.now();
    const out = await rule.fix({}, ctxFor(doc));
    const ms = Date.now() - t0;
    expect(out.found).toHaveLength(0);
    // Порог с большим запасом от замеренных 11 мс, но втрое ниже стоимости полного
    // разбора: если отсев уберут, тест это заметит.
    expect(ms, `разбор 33 текстур занял ${ms} мс`).toBeLessThan(700);
  }, 120000);
});
