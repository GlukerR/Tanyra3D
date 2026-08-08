// scripts/bundle-ktx.mjs — кладёт `ktx` из KTX-Software в `.tools/` перед сборкой пакета.
//
// Зачем отдельно от scripts/setup.mjs. Тот СТАВИТ инструмент в систему и спрашивает
// разрешения — так и надо, когда человек ставит программу себе. Здесь другое: файл нужен
// внутри собираемого пакета, а не в системе сборочной машины. Ставить что-то в систему
// CI бессмысленно (её выбросят через минуту), а спрашивать некого.
//
// Почему это вообще делается. Без ktx у собранного приложения не работает KTX2 — одна из
// двух текстурных оптимизаций. Требовать от художника отдельно поставить нативную
// программу Khronos значит вернуть ему терминал, ради избавления от которого приложение
// и собирается. Лицензия Apache-2.0 вкладывать разрешает.
//
// Запускается на СВОЕЙ платформе: под Windows кладёт windows-сборку, под macOS — macOS.
// Кросс-платформенной сборки здесь нет и не планируется — каждый пакет собирает свой
// раннер (.github/workflows/release.yml).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(root, '.tools');
const VERSION = '4.4.2';
const BASE = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}`;

const OPTIONAL = process.argv.includes('--optional');

const say = (s) => console.log(s);
const die = (s) => {
  if (OPTIONAL) {
    say(`  ! ${s}`);
    say('    Собираем без KTX2 (--optional). Всё остальное работает.');
    process.exit(0);
  }
  console.error(`  x ${s}`);
  process.exit(1);
};

/** Уже лежит? Второй раз не качаем — сборка запускается часто. */
function alreadyThere() {
  if (!fs.existsSync(TOOLS)) return null;
  const stack = [TOOLS];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'ktx' || e.name === 'ktx.exe') return full;
    }
  }
  return null;
}

/** Имя файла в релизе Khronos под текущую платформу и разрядность. */
function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `KTX-Software-${VERSION}-Windows-${arch}.exe`;
  if (process.platform === 'darwin') {
    return `KTX-Software-${VERSION}-Darwin-${arch === 'arm64' ? 'arm64' : 'x86_64'}.pkg`;
  }
  return `KTX-Software-${VERSION}-Linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.bz2`;
}

async function download(name) {
  const url = `${BASE}/${name}`;
  say(`  · качаю ${name}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`${url} — ответ ${res.status}`);
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  say(`    ${(fs.statSync(tmp).size / 1048576).toFixed(1)} МБ`);
  return tmp;
}

/** Распаковка БЕЗ установки: файл нужен в пакете, а не в системе сборочной машины. */
function extract(file) {
  fs.mkdirSync(TOOLS, { recursive: true });
  if (process.platform === 'linux') {
    execFileSync('tar', ['-xjf', file, '-C', TOOLS], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'darwin') {
    // .pkg — это архив xar с вложенным Payload. pkgutil разворачивает и то и другое,
    // не трогая систему, в отличие от `installer -pkg`.
    const exp = path.join(os.tmpdir(), 'ktx-pkg-expanded');
    fs.rmSync(exp, { recursive: true, force: true });
    execFileSync('pkgutil', ['--expand-full', file, exp], { stdio: 'inherit' });
    execFileSync('sh', ['-c', `cp -R "${exp}"/*/Payload/* "${TOOLS}/" 2>/dev/null || cp -R "${exp}"/Payload/* "${TOOLS}/"`], { stdio: 'inherit' });
    return;
  }
  // Windows: Khronos выкладывает только установщик. 7-Zip читает его как архив и
  // достаёт содержимое, ничего не запуская и не трогая реестр. Встроенного средства,
  // умеющего вскрыть установщик, в Windows нет — Expand-Archive понимает только zip.
  const sevenZip = ['7z', path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe')]
    .find((c) => {
      try { execFileSync(c, ['i'], { stdio: 'ignore' }); return true; } catch { return false; }
    });
  if (!sevenZip) {
    die('нужен 7-Zip, его нет в PATH. На раннерах GitHub он есть; локально — https://www.7-zip.org');
  }
  execFileSync(sevenZip, ['x', file, `-o${TOOLS}`, '-y'], { stdio: 'inherit' });
}

const found0 = alreadyThere();
if (found0) {
  say(`  ✓ ktx уже в .tools — ${path.relative(root, found0)}`);
  process.exit(0);
}

say(`Tanyra3D — укладываю ktx ${VERSION} в пакет (${process.platform}/${process.arch})`);
const file = await download(assetName());
try {
  extract(file);
} catch (e) {
  die(`распаковать не удалось: ${e.message}`);
}

const found = alreadyThere();
if (!found) die('после распаковки ktx не найден — раскладка архива изменилась');

// Достали файл — а запускается ли он. Молча положить нерабочий бинарник хуже, чем не
// положить никакого: во втором случае KTX2 честно скажет, что инструмента нет.
try {
  if (process.platform !== 'win32') fs.chmodSync(found, 0o755);
  execFileSync(found, ['--version'], { stdio: 'pipe', timeout: 20_000 });
} catch (e) {
  die(`${path.relative(root, found)} не запускается: ${(e.message || '').split('\n')[0]}`);
}

say(`  ✓ ${path.relative(root, found)} — работает, поедет в пакет`);
