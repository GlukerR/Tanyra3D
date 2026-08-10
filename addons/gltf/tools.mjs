// addons/gltf/tools.mjs — обнаружение внешних бинарников glTF-тулинга (gltf-transform
// CLI и KTX-Software `ktx`/`toktx`) и запуск CLI. Инфраструктура аддона gltf, а не
// отдельный формат: KTX2-кодирование идёт через gltf-transform CLI + toktx, оба нужны
// только правилу textures/ktx2. Вынесено из optimize2.mjs без изменения логики.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
// fileURLToPath, а не `.pathname` вручную: `.pathname` отдаёт URL-строку, где пробел
// закодирован как %20, а кириллица — процентами. Для `C:\Program Files\Tanyra3D` это
// значило «CLI не найден», и разбираться приходилось уже по отказу KTX2. Снятие
// префикса `/` регуляркой лечило только букву диска и молчало про всё остальное.
// Ревью 2026-08-10 (P1.2).
import { fileURLToPath } from 'node:url';

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

// CLI ищем СНАЧАЛА среди своих зависимостей, потом в PATH.
//
// Раньше он искался только в PATH, то есть человек обязан был отдельно поставить
// его глобально — и узнавал об этом, когда KTX2 уже отказался работать. Теперь
// пакет стоит в зависимостях и приезжает вместе с `npm install`; поиск в PATH
// остался запасным путём для тех, у кого он уже стоит глобально.
function findLocalCli() {
  try {
    const pkgJson = new URL('../../node_modules/@gltf-transform/cli/package.json', import.meta.url);
    const dir = path.dirname(fileURLToPath(pkgJson));
    if (!fs.existsSync(path.join(dir, 'package.json'))) return null;
    return dir;
  } catch {
    return null;
  }
}

const LOCAL_CLI_DIR = findLocalCli();

export const GLTF_CLI = findInPath(['gltf-transform.cmd', 'gltf-transform']);

// JS-вход CLI: вызываем его напрямую текущим node, минуя .cmd-обёртку
// (.cmd внутри вызывает "node" через shell — ломается двойным слоем кавычек на Windows)
function findCliJs() {
  // своя зависимость важнее глобальной: её версия сверена с ядром
  if (LOCAL_CLI_DIR) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(LOCAL_CLI_DIR, 'package.json'), 'utf8'));
      let bin = pkg.bin;
      if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
      if (typeof bin === 'string') {
        const p = path.join(LOCAL_CLI_DIR, bin);
        if (fs.existsSync(p)) return p;
      }
    } catch { /* повреждённый пакет — пробуем PATH */ }
  }
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

// Один ответ на вопрос «CLI вообще есть?». До появления локальной зависимости
// правило и тесты спрашивали GLTF_CLI (только PATH) — теперь этого мало: пакет
// может стоять в node_modules, а в PATH его нет, и проверка соврала бы «нет».
export const HAS_GLTF_CLI = Boolean(GLTF_CLI_JS || GLTF_CLI);

// Локальная установка, которую кладёт `npm run setup` под Linux: там Khronos
// выложил распаковываемый архив, и ktx живёт прямо в проекте, без прав
// администратора. Под Windows/macOS выложены только установщики, поэтому там
// бинарник оказывается в системных папках — их ловят candidates ниже.
// В настольном приложении инструмент лежит не рядом с исходниками, а в ресурсах
// собранного пакета, и путь туда знает только оболочка. Она называет его переменной —
// иначе аддону пришлось бы догадываться о раскладке Electron, о которой он знать не
// должен. Нет переменной — прежнее поведение, папка `.tools/` в корне проекта.
function findInTools() {
  const dir0 = process.env.TANYRA_TOOLS_DIR
    || fileURLToPath(new URL('../../.tools/', import.meta.url));
  if (!fs.existsSync(dir0)) return null;
  const stack = [dir0];
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
  return findInTools();
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

// Потолок на внешний CLI (BUG-007). Зависший toktx (битая текстура, нехватка памяти,
// драйверный баг) без потолка не вернётся никогда, и задача повиснет навсегда.
// Оговорка: в ветке с shell:true убивается .cmd-обёртка, сам toktx может пережить её;
// но пайплайн уже не ждёт его, а temp-каталог сносится в finally у правила.
const CLI_TIMEOUT_MS = 10 * 60_000;
// Потолок на собранный вывод. Болтливый CLI на модели с сотней текстур иначе копит
// мегабайты текста, из которого нужны последние десять строк.
const CLI_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Сборщик текста из кусков потока, с потолком.
 *
 * Через StringDecoder, а не `chunk.toString()`. Поток режется по границе БАЙТА, а не
 * символа: буква в UTF-8 занимает два-три байта и запросто оказывается разорванной
 * между двумя кусками. `toString()` на каждом куске превращает такую букву в «□», и
 * путь вида `модель.glb` приезжает в сообщение об ошибке кашей. Раньше этого не было:
 * execFileSync отдавал готовый буфер целиком. Найдено ревью 2026-08-10 — дефект,
 * внесённый переводом на spawn в тот же день.
 *
 * Потолок — тот же смысл, что был у maxBuffer: болтливый CLI на модели с сотней текстур
 * иначе копит мегабайты текста ради последних десяти строк. Хвост важнее начала,
 * поэтому режем начало.
 *
 * Экспортируется ради проверок: разрыв многобайтного символа воспроизводится только
 * определённой нарезкой потока, и через настоящий CLI её не подстроить — короткий
 * вывод приезжает одним куском (проверено: тест на живом CLI мутацию НЕ ловит).
 */
export function makeTextCollector(limit = CLI_MAX_BUFFER) {
  const decoder = new StringDecoder('utf8');
  let acc = '';
  const cap = (s) => (s.length > limit ? s.slice(s.length - limit) : s);
  return {
    push(chunk) { acc = cap(acc + decoder.write(chunk)); },
    // Хвост декодера: поток кончился на середине буквы — она дожидается здесь.
    end() { acc = cap(acc + decoder.end()); return acc; },
  };
}

/**
 * Запуск gltf-transform CLI для фазы KTX2 (кодирование через toktx).
 *
 * АСИНХРОННЫЙ. Раньше здесь стоял `execFileSync`, и это значило вот что: сервер зовёт
 * optimizeFile прямо в обработчике запроса, а кодирование текстур идёт минутами.
 * Всё это время event loop занят — прогресс по SSE замирает на месте, вторая модель
 * ждёт своей очереди молча, отменить нельзя, и со стороны программа выглядит зависшей.
 * Таймаут выше эту беду ограничивал десятью минутами, но не убирал.
 * Ревью 2026-08-10 (P1.1).
 *
 * Поведение при отказе оставлено прежним дословно: те же два сообщения, тот же хвост
 * вывода. Менялся способ ожидания, а не то, что видит человек.
 */
export function runCli(args) {
  const useNode = Boolean(GLTF_CLI_JS);
  const file = useNode ? process.execPath : GLTF_CLI;
  const argv = useNode ? [GLTF_CLI_JS, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: !useNode && GLTF_CLI.endsWith('.cmd'),
    });

    const outBuf = makeTextCollector();
    const errBuf = makeTextCollector();
    child.stdout.on('data', (c) => outBuf.push(c));
    child.stderr.on('data', (c) => errBuf.push(c));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);

    const fail = (message) => { clearTimeout(timer); reject(new Error(message)); };

    child.on('error', (e) => fail(`gltf-transform ${args[0]} failed:\n    ${e.message}`));

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = outBuf.end();
      const err = errBuf.end();
      if (timedOut) {
        // при таймауте stderr пуст, а причина — сигнал: без отдельной ветки
        // пользователь увидел бы невнятное «failed» вместо причины
        reject(new Error(`gltf-transform ${args[0]} превысил ${Math.round(CLI_TIMEOUT_MS / 60_000)} мин и был остановлен`));
        return;
      }
      if (code === 0) { resolve(); return; }
      const raw = (err + '\n' + out).trim();
      const tail = raw ? raw.split('\n').slice(-10).join('\n    ') : `exit ${code}${signal ? ` (${signal})` : ''}`;
      reject(new Error(`gltf-transform ${args[0]} failed:\n    ${tail}`));
    });
  });
}
