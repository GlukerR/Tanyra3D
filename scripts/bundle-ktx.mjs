import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(root, '.tools');
const VERSION = '4.4.2';
const BASE = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}`;
const MANIFEST = path.join(root, 'scripts', 'ktx-manifest.json');

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

function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `KTX-Software-${VERSION}-Windows-${arch}.exe`;
  if (process.platform === 'darwin') {
    return `KTX-Software-${VERSION}-Darwin-${arch === 'arm64' ? 'arm64' : 'x86_64'}.pkg`;
  }
  return `KTX-Software-${VERSION}-Linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.bz2`;
}

const halt = (s) => {
  console.error(`  x ${s}`);
  process.exit(1);
};

function knownHashes() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return (m && m.sha256) || {};
  } catch {
    return {};
  }
}

function verifyHash(name, buf) {
  const actual = createHash('sha256').update(buf).digest('hex');
  const expected = knownHashes()[name];
  if (!expected) {
    halt([
      `${name} — в манифесте нет записи, проверить нечем.`,
      `    посчитанный SHA-256: ${actual}`,
      '    Сверьте его с публикацией Khronos и внесите в scripts/ktx-manifest.json.',
      '    Непроверенный бинарник в установщик не кладём.',
    ].join('\n'));
  }
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    halt([
      `${name} — хеш не совпал с манифестом.`,
      `    ожидали:  ${expected}`,
      `    получили: ${actual}`,
      '    Сборка остановлена. Либо Khronos перевыложил файл (тогда обновите манифест,',
      '    сверив с публикацией), либо это не тот файл, который должен быть.',
    ].join('\n'));
  }
  say('    хеш совпал с манифестом');
}

async function download(name) {
  const url = `${BASE}/${name}`;
  say(`  · качаю ${name}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`${url} — ответ ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  say(`    ${(buf.length / 1048576).toFixed(1)} МБ`);
  verifyHash(name, buf);
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

function extract(file) {
  fs.mkdirSync(TOOLS, { recursive: true });
  if (process.platform === 'linux') {
    execFileSync('tar', ['-xjf', file, '-C', TOOLS], { stdio: 'inherit' });
    return;
  }
  if (process.platform === 'darwin') {
    const exp = path.join(os.tmpdir(), 'ktx-pkg-expanded');
    fs.rmSync(exp, { recursive: true, force: true });
    execFileSync('pkgutil', ['--expand-full', file, exp], { stdio: 'inherit' });
    execFileSync('sh', ['-c', `cp -R "${exp}"/*/Payload/* "${TOOLS}/" 2>/dev/null || cp -R "${exp}"/Payload/* "${TOOLS}/"`], { stdio: 'inherit' });
    return;
  }
  const sevenZip = ['7z', path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe')]
    .find((c) => {
      try { execFileSync(c, ['i'], { stdio: 'ignore' }); return true; } catch { return false; }
    });
  if (!sevenZip) {
    die('нужен 7-Zip, его нет в PATH. На раннерах GitHub он есть; локально — https://www.7-zip.org');
  }
  execFileSync(sevenZip, ['x', file, `-o${TOOLS}`, '-y'], { stdio: 'inherit' });
}

function checkBinary(binary) {
  let out = '';
  try {
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    out = String(execFileSync(binary, ['--version'], { stdio: 'pipe', timeout: 20_000 }));
  } catch (e) {
    die(`${path.relative(root, binary)} не запускается: ${(e.message || '').split('\n')[0]}`);
  }
  const versionRe = new RegExp(`v?${VERSION.replace(/\./g, '\\.')}(?![\\d.])`);
  if (!versionRe.test(out)) {
    halt([
      `${path.relative(root, binary)} — версия не та.`,
      `    ожидали ${VERSION}, инструмент говорит: ${out.trim().split('\n')[0] || '(молчит)'}`,
      '    Уберите .tools/ и запустите заново.',
    ].join('\n'));
  }
}

const found0 = alreadyThere();
if (found0) {
  checkBinary(found0);
  say(`  ✓ ktx уже в .tools — ${path.relative(root, found0)} (${VERSION})`);
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

checkBinary(found);
say(`  ✓ ${path.relative(root, found)} — ${VERSION}, работает, поедет в пакет`);
