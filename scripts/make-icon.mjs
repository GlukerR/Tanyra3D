import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'desktop', 'build');
const SRC = process.argv[2] || path.join(OUT_DIR, 'logo-source.png');
const OUT = path.join(OUT_DIR, 'icon.png');

const SIZE = 1024;
const MARGIN = 0.06;
const WHITE = 232;
const EMPTY_ROW = 2;

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
if (run && rowInk.slice(run.to + 1).some((n) => n >= EMPTY_ROW)) {
  if (!gap || run.to - run.from > gap.to - gap.from) gap = run;
}
const cutY = gap ? gap.from : H;
console.log(`Надпись отрезана по y=${cutY} из ${H}`);

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

const out = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const s = at(x, y);
    const d = (y * w + x) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    out[d + 3] = outside[y * w + x] ? 0 : data[s + 3];
  }
}

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
