import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CHECK_ONLY = process.argv.includes('--check');
const ASSUME_YES = process.argv.includes('--yes') || process.argv.includes('-y');
const WITH_TESTS = process.argv.includes('--tests');

const KTX_VERSION = '4.4.2';
const KTX_BASE = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}`;

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m•\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOOLS_DIR = path.join(root, '.tools');

let missingOptional = 0;

console.log('');
console.log('Tanyra3D — environment check');
console.log('');

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 9)) {
  console.log(ok(`Node ${process.versions.node}`));
} else {
  console.log(bad(`Node ${process.versions.node} — 20.9 or newer required (sharp needs it)`));
  console.log(dim('    https://nodejs.org/'));
  process.exit(1);
}

if (!existsSync(path.join(root, 'node_modules'))) {
  console.log(bad('Dependencies are not installed'));
  console.log(dim('    npm install'));
  process.exit(1);
}
console.log(ok('Dependencies installed'));

if (existsSync(path.join(root, 'node_modules', '@gltf-transform', 'cli'))) {
  console.log(ok('Texture encoding tool (@gltf-transform/cli)'));
} else {
  console.log(bad('@gltf-transform/cli is missing — run npm install again'));
  missingOptional += 1;
}


function findKtx() {
  if (process.env.TANYRA_SETUP_NO_KTX === '1') return null;
  const names = process.platform === 'win32' ? ['ktx.exe', 'toktx.exe'] : ['ktx', 'toktx'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) if (dir && existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  const extra = [
    'C:\\Program Files\\KTX-Software\\bin\\ktx.exe',
    'C:\\Program Files (x86)\\KTX-Software\\bin\\ktx.exe',
    '/usr/local/bin/ktx',
    '/opt/homebrew/bin/ktx',
    '/usr/bin/ktx',
  ];
  for (const p of extra) if (existsSync(p)) return p;
  return findInTools();
}

function findInTools() {
  if (!existsSync(TOOLS_DIR)) return null;
  const stack = [TOOLS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'ktx' || e.name === 'ktx.exe') return full;
    }
  }
  return null;
}

function ktxAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'linux') {
    return { name: `KTX-Software-${KTX_VERSION}-Linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.bz2`, kind: 'tar' };
  }
  if (process.platform === 'win32') {
    return { name: `KTX-Software-${KTX_VERSION}-Windows-${arch}.exe`, kind: 'installer' };
  }
  if (process.platform === 'darwin') {
    return { name: `KTX-Software-${KTX_VERSION}-Darwin-${arch === 'arm64' ? 'arm64' : 'x86_64'}.pkg`, kind: 'pkg' };
  }
  return null;
}

function manualHint() {
  console.log(dim('    Install it yourself any time:'));
  if (process.platform === 'win32') {
    console.log(dim('      winget install KhronosGroup.KTX-Software'));
  } else if (process.platform === 'linux') {
    console.log(dim('      your distro package, or the release below'));
  }
  console.log(dim(`      https://github.com/KhronosGroup/KTX-Software/releases/tag/v${KTX_VERSION}`));
}

function ask(question) {
  if (ASSUME_YES) return Promise.resolve(true);
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(/^(y|yes|д|да)$/i.test(a.trim()));
    });
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

async function verifySha1(buf, assetName) {
  let expected;
  try {
    const res = await fetch(`${KTX_BASE}/${assetName}.sha1`, { redirect: 'follow' });
    if (!res.ok) return null;
    expected = (await res.text()).trim().split(/\s+/)[0];
  } catch { return null; }
  if (!/^[0-9a-f]{40}$/i.test(expected)) return null;
  const actual = createHash('sha1').update(buf).digest('hex');
  return actual.toLowerCase() === expected.toLowerCase();
}

async function installKtx() {
  const asset = ktxAsset();
  if (!asset) {
    console.log(warn(`No KTX-Software build published for ${process.platform}/${process.arch}`));
    manualHint();
    return null;
  }

  const tmp = path.join(os.tmpdir(), asset.name);
  console.log(dim(`    downloading ${asset.name} …`));

  let buf;
  try {
    buf = await download(`${KTX_BASE}/${asset.name}`, tmp);
  } catch (e) {
    console.log(bad(`Download failed: ${e.message}`));
    manualHint();
    return null;
  }

  const sha = await verifySha1(buf, asset.name);
  if (sha === false) {
    console.log(bad('Checksum mismatch — the download is not what Khronos published. Aborting.'));
    try { rmSync(tmp, { force: true }); } catch {  }
    return null;
  }
  console.log(dim(sha === true ? '    checksum ok' : '    (no checksum published for this file)'));

  try {
    if (asset.kind === 'tar') {
      mkdirSync(TOOLS_DIR, { recursive: true });
      execFileSync('tar', ['-xjf', tmp, '-C', TOOLS_DIR], { stdio: 'pipe' });
    } else if (asset.kind === 'installer') {
      console.log(dim('    starting the official installer — confirm the Windows prompt'));
      execFileSync(tmp, [], { stdio: 'inherit' });
    } else if (asset.kind === 'pkg') {
      console.log(dim('    installing — macOS will ask for your password'));
      execFileSync('sudo', ['installer', '-pkg', tmp, '-target', '/'], { stdio: 'inherit' });
    }
  } catch (e) {
    console.log(bad(`Installation did not finish: ${e.message.split('\n')[0]}`));
    manualHint();
    return null;
  } finally {
    if (asset.kind === 'tar') { try { rmSync(tmp, { force: true }); } catch {  } }
  }

  const found = findKtx();
  if (!found) {
    console.log(bad('Installed, but the binary was not found where expected'));
    manualHint();
    return null;
  }

  try {
    execFileSync(found, ['--version'], { stdio: 'pipe', timeout: 20_000 });
  } catch (e) {
    console.log(bad(`Found at ${found}, but it does not run: ${String(e.message).split('\n')[0]}`));
    console.log(dim('    Most likely its shared library is not alongside it.'));
    manualHint();
    return null;
  }

  return found;
}

let ktx = findKtx();
if (ktx) {
  console.log(ok(`KTX2 encoder (${ktx})`));
} else if (CHECK_ONLY) {
  missingOptional += 1;
  console.log(warn('KTX2 encoder not found — KTX2 texture compression unavailable'));
  console.log(dim('      npm run setup — offers to install it'));
} else {
  console.log(warn('KTX2 encoder not found — KTX2 texture compression unavailable'));
  console.log(dim('    Everything else works without it.'));
  const yes = await ask(
    `    Download and install KTX-Software ${KTX_VERSION} from the official Khronos release? [y/N] `,
  );
  if (yes) {
    ktx = await installKtx();
    if (ktx) console.log(ok(`KTX2 encoder (${ktx})`));
    else missingOptional += 1;
  } else {
    missingOptional += 1;
    manualHint();
  }
}

if (CHECK_ONLY) {
  console.log(dim('  Browser for the tests — not checked in doctor mode'));
} else if (!WITH_TESTS) {
  console.log(dim('  Browser for the tests — skipped: the program does not need it'));
  console.log(dim('      npm run setup -- --tests   — installs it (hundreds of MB), for running the tests'));
} else {
  console.log(dim('  … installing Chromium for the browser tests'));
  try {
    execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', cwd: root, shell: true });
    console.log(ok('Chromium for the browser tests'));
  } catch {
    missingOptional += 1;
    console.log(warn('Could not install Chromium — the browser tests will not run'));
    console.log(dim('      npm test -- --project node  — runs everything else'));
  }
}

console.log('');
if (missingOptional === 0) {
  console.log(ok('Done. Everything is in place.'));
} else {
  console.log(warn(`Done. Optional pieces missing: ${missingOptional}.`));
  console.log(dim('  The program runs anyway — what is missing only disables what depends'));
  console.log(dim('  on it, and the report says so plainly.'));
}
console.log('');
console.log(dim('  npm start   — open the program in your browser'));
console.log('');
