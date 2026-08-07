// scripts/setup.mjs — одна команда вместо списка «поставьте это, потом то».
//
//   npm run setup     проверить и доустановить, что можно доустановить
//   npm run doctor    только проверить, ничего не менять
//
// Что здесь есть и чего нет. Всё, что ставится через npm, приезжает само вместе
// с `npm install` — CLI для KTX2 переехал в зависимости именно ради этого.
// Остаётся ровно две вещи, которые npm поставить не может:
//
//   1. Chromium для браузерных тестов — качается playwright'ом, одна команда,
//      её мы выполняем сами.
//   2. `ktx` из KTX-Software — это отдельная нативная программа Khronos, в npm
//      её нет ни в каком виде. Скачивать и распаковывать чужие исполняемые
//      файлы за спиной у человека мы не будем: скрипт печатает готовую строку
//      под его систему, а решение — за ним.
//
// Скрипт никогда не падает молча: чего нет, о том сказано прямо, и сказано,
// что именно из-за этого не будет работать.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CHECK_ONLY = process.argv.includes('--check');

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m•\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let missingOptional = 0;

console.log('');
console.log('Tanyra3D — проверка окружения');
console.log('');

// ---------- 1. Node ----------
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) {
  console.log(ok(`Node ${process.versions.node}`));
} else {
  console.log(bad(`Node ${process.versions.node} — нужен 18 или новее`));
  console.log(dim('    https://nodejs.org/'));
  process.exit(1);
}

// ---------- 2. зависимости ----------
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (!existsSync(path.join(root, 'node_modules'))) {
  console.log(bad('Зависимости не установлены'));
  console.log(dim('    npm install'));
  process.exit(1);
}
console.log(ok('Зависимости установлены'));

// ---------- 3. CLI для KTX2 (своя зависимость) ----------
const cliDir = path.join(root, 'node_modules', '@gltf-transform', 'cli');
if (existsSync(cliDir)) {
  console.log(ok('Инструмент кодирования текстур (@gltf-transform/cli)'));
} else {
  console.log(bad('@gltf-transform/cli не установлен — повторите npm install'));
  missingOptional += 1;
}

// ---------- 4. ktx из KTX-Software ----------
function findKtx() {
  const names = process.platform === 'win32' ? ['ktx.exe', 'toktx.exe'] : ['ktx', 'toktx'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) if (dir && existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  const extra = [
    'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files (x86)\\KTX-Software\\bin\\ktx.exe',
    '/usr/local/bin/ktx',
    '/opt/homebrew/bin/ktx',
  ];
  for (const p of extra) if (existsSync(p)) return p;
  return null;
}

const ktx = findKtx();
if (ktx) {
  console.log(ok(`Кодировщик KTX2 (${ktx})`));
} else {
  missingOptional += 1;
  console.log(warn('Кодировщик KTX2 не найден — сжатие текстур в KTX2 будет недоступно'));
  console.log(dim('    Всё остальное работает. Поставить можно так:'));
  if (process.platform === 'win32') {
    console.log(dim('      winget install KhronosGroup.KTX-Software'));
  } else if (process.platform === 'darwin') {
    console.log(dim('      brew install ktx'));
  } else {
    console.log(dim('      см. пакет вашего дистрибутива или релизы:'));
  }
  console.log(dim('      https://github.com/KhronosGroup/KTX-Software/releases'));
}

// ---------- 5. Chromium для браузерных тестов ----------
function chromiumPresent() {
  try {
    execSync('npx playwright install --dry-run chromium', { stdio: 'pipe', cwd: root });
    return true;
  } catch {
    return false;
  }
}

if (CHECK_ONLY) {
  console.log(warn('Chromium для браузерных тестов — не проверяю в режиме doctor'));
  console.log(dim('      npm run setup — поставит, если нужен'));
} else {
  console.log(dim('  … ставлю Chromium для браузерных тестов (нужен только тестам)'));
  try {
    execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', cwd: root, shell: true });
    console.log(ok('Chromium для браузерных тестов'));
  } catch {
    missingOptional += 1;
    console.log(warn('Chromium поставить не удалось — браузерная часть тестов не пойдёт'));
    console.log(dim('      npm test -- --project node  — прогнать остальное'));
  }
}

// ---------- итог ----------
console.log('');
if (missingOptional === 0) {
  console.log(ok('Готово. Всё на месте.'));
} else {
  console.log(warn(`Готово. Необязательного не хватает: ${missingOptional}.`));
  console.log(dim('  Программа запустится и будет работать — недостающее отключит только то,'));
  console.log(dim('  что от него зависит, и скажет об этом в отчёте.'));
}
console.log('');
console.log(dim('  npm start   — открыть в браузере'));
console.log(dim('  npm test    — прогнать тесты'));
console.log('');
