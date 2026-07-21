// addons/gltf/tools.mjs — обнаружение внешних бинарников glTF-тулинга (gltf-transform
// CLI и KTX-Software `ktx`/`toktx`) и запуск CLI. Инфраструктура аддона gltf, а не
// отдельный формат: KTX2-кодирование идёт через gltf-transform CLI + toktx, оба нужны
// только правилу textures/ktx2. Вынесено из optimize2.mjs без изменения логики.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------- поиск внешних инструментов ----------
function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export const GLTF_CLI = findInPath(['gltf-transform.cmd', 'gltf-transform']);

// JS-вход CLI: вызываем его напрямую текущим node, минуя .cmd-обёртку
// (.cmd внутри вызывает "node" через shell — ломается двойным слоем кавычек на Windows)
function findCliJs() {
  if (!GLTF_CLI) return null;
  const pkgDir = path.join(path.dirname(GLTF_CLI), 'node_modules', '@gltf-transform', 'cli');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    let bin = pkg.bin;
    if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
    if (typeof bin === 'string') {
      const p = path.join(pkgDir, bin);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* нет package.json — используем .cmd как запасной путь */ }
  return null;
}
export const GLTF_CLI_JS = findCliJs();

function findToktx() {
  // gltf-transform CLI v4 требует бинарник `ktx` (KTX-Software 4.3+); toktx — запасной признак установки
  const inPath = findInPath(['ktx.exe', 'ktx', 'toktx.exe', 'toktx']);
  if (inPath) return inPath;
  const candidates = [
    'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files (x86)\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files\\KTX-Software\\bin\\toktx.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// Инструмент ищем всегда (нужен и API-вызовам); --no-ktx отключает само правило
// textures/ktx2 через meta.enabled, поэтому найденный TOKTX при noKtx не используется.
export const TOKTX = findToktx();
const childEnv = { ...process.env };
if (TOKTX) {
  const dir = path.dirname(TOKTX);
  // на Windows ключ называется `Path` — ищем реальный ключ без учёта регистра,
  // иначе создаётся дубликат PATH, который ЗАМЕНЯЕТ системный путь у дочернего процесса
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!(childEnv[pathKey] || '').includes(dir)) childEnv[pathKey] = dir + path.delimiter + (childEnv[pathKey] || '');
}

export function runCli(args) {
  // gltf-transform CLI для фазы KTX2 (кодирование через toktx)
  try {
    if (GLTF_CLI_JS) {
      execFileSync(process.execPath, [GLTF_CLI_JS, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      execFileSync(GLTF_CLI, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: GLTF_CLI.endsWith('.cmd') });
    }
  } catch (e) {
    const raw = ((e.stderr || '') + '\n' + (e.stdout || '')).toString().trim();
    const tail = raw ? raw.split('\n').slice(-10).join('\n    ') : e.message;
    throw new Error(`gltf-transform ${args[0]} завершился с ошибкой:\n    ${tail}`);
  }
}
