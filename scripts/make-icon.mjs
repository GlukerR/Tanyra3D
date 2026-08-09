// scripts/make-icon.mjs — иконка приложения из исходного логотипа.
//
// Зачем скриптом, а не руками в редакторе. Логотип ещё поменяется, а вместе с ним
// придётся заново вырезать, обрезать, центрировать и выравнивать поля — четыре шага,
// каждый из которых делается на глаз и каждый раз чуть иначе. Здесь они записаны
// числами: поменялся логотип — перезапустил, получил ту же иконку из новой картинки.
//
// Три вещи, которые делаются не «для красоты»:
//
// 1. НАДПИСЬ ОТРЕЗАЕТСЯ. В логотипе под эмблемой стоит «TANYRA3D OPTIMIZER». Иконка
//    живёт в 32×32 в панели задач и в 16×16 на вкладке — там от надписи остаётся
//    серая полоса грязи. Название человек и так видит рядом со значком.
//
// 2. БЕЛОЕ УБИРАЕТСЯ ТОЛЬКО СНАРУЖИ, заливкой от краёв. Убрать «весь белый» нельзя:
//    внутри эмблемы есть почти белые грани, и они превратились бы в дырки.
//
// 3. ПОЛЯ ОДИНАКОВЫЕ. Системы рисуют значок в своей рамке и сами добавляют отступ;
//    вплотную обрезанная картинка выглядит крупнее соседних и «вылезает».
//
// Запуск:  node scripts/make-icon.mjs [исходник.png]
// Вход:    desktop/build/logo-source.png — полный логотип, с надписью
// Выход:   desktop/build/icon.png (1024×1024) — дальше electron-builder сам сделает
//          из него .ico для Windows, .icns для macOS и набор размеров для Linux.
//
// Обе картинки лежат в git: исходник — чтобы иконку можно было пересобрать, результат —
// чтобы сборка не зависела от того, запускал ли кто-то этот скрипт.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'desktop', 'build');
const SRC = process.argv[2] || path.join(OUT_DIR, 'logo-source.png');
const OUT = path.join(OUT_DIR, 'icon.png');

const SIZE = 1024;        // размер, из которого система нарежет остальные
const MARGIN = 0.06;      // поля вокруг эмблемы, доля стороны
const WHITE = 232;        // от какого значения канал считаем «фоном»
const EMPTY_ROW = 2;      // сколько «чернильных» пикселей в строке считаем пустотой

if (!fs.existsSync(SRC)) {
  console.error(`Исходник не найден: ${SRC}`);
  process.exit(1);
}

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

const at = (x, y) => (y * W + x) * C;
const isBackground = (x, y) => {
  const i = at(x, y);
  if (data[i + 3] < 16) return true;
  return data[i] > WHITE && data[i + 1] > WHITE && data[i + 2] > WHITE;
};

// ---- 1. Где кончается эмблема и начинается надпись ----
//
// Ищем не «текст» — распознавать его нечем, — а самую широкую пустую полосу в нижней
// половине. Между эмблемой и подписью дизайнер всегда оставляет воздух, и он шире,
// чем просветы внутри самой эмблемы. Полосу берём только ниже середины: сверху
// пустота — это поле над картинкой, а не разделитель.
const rowInk = [];
for (let y = 0; y < H; y++) {
  let n = 0;
  for (let x = 0; x < W; x += 2) if (!isBackground(x, y)) n++;
  rowInk.push(n);
}
let gap = null;
let run = null;
for (let y = Math.floor(H * 0.5); y < H; y++) {
  if (rowInk[y] < EMPTY_ROW) {
    run = run || { from: y };
    run.to = y;
  } else if (run) {
    if (!gap || run.to - run.from > gap.to - gap.from) gap = run;
    run = null;
  }
}
// Последняя полоса пустоты — это поле под всей картинкой, разделителем она быть не может.
if (run && rowInk.slice(run.to + 1).some((n) => n >= EMPTY_ROW)) {
  if (!gap || run.to - run.from > gap.to - gap.from) gap = run;
}
const cutY = gap ? gap.from : H;
console.log(`Надпись отрезана по y=${cutY} из ${H}`);

// ---- 2. Убрать фон снаружи: заливка от краёв ----
const w = W;
const h = cutY;
const outside = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) { stack.push(x, 0); stack.push(x, h - 1); }
for (let y = 0; y < h; y++) { stack.push(0, y); stack.push(w - 1, y); }
while (stack.length) {
  const y = stack.pop();
  const x = stack.pop();
  if (x < 0 || y < 0 || x >= w || y >= h) continue;
  const k = y * w + x;
  if (outside[k]) continue;
  if (!isBackground(x, y)) continue;
  outside[k] = 1;
  stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}

// ---- 3. Плотная рамка вокруг того, что осталось ----
let minX = w, minY = h, maxX = -1, maxY = -1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    if (outside[y * w + x]) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
if (maxX < 0) {
  console.error('После удаления фона ничего не осталось — проверьте порог WHITE.');
  process.exit(1);
}
console.log(`Эмблема: ${maxX - minX + 1}×${maxY - minY + 1} в точке (${minX}, ${minY})`);

// ---- 4. Собрать RGBA: снаружи прозрачно, внутри как было ----
const out = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const s = at(x, y);
    const d = (y * w + x) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    out[d + 3] = outside[y * w + x] ? 0 : data[s + 3];
  }
}

// ---- 5. Квадрат с одинаковыми полями ----
const cw = maxX - minX + 1;
const ch = maxY - minY + 1;
const inner = Math.round(SIZE * (1 - MARGIN * 2));
const scale = inner / Math.max(cw, ch);
const rw = Math.max(1, Math.round(cw * scale));
const rh = Math.max(1, Math.round(ch * scale));

const emblem = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
  .extract({ left: minX, top: minY, width: cw, height: ch })
  .resize(rw, rh, { fit: 'fill', kernel: 'lanczos3' })
  .png()
  .toBuffer();

fs.mkdirSync(OUT_DIR, { recursive: true });
await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: emblem, left: Math.round((SIZE - rw) / 2), top: Math.round((SIZE - rh) / 2) }])
  .png({ compressionLevel: 9 })
  .toFile(OUT);

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Готово: ${path.relative(root, OUT)} — ${SIZE}×${SIZE}, ${kb} КБ`);
