import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findInPath(names: string[]): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findLocalCli(): string | null {
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

interface CliPackageJson {
  bin?: string | Record<string, string>;
}

function findCliJs(): string | null {
  if (LOCAL_CLI_DIR) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(LOCAL_CLI_DIR, 'package.json'), 'utf8')) as CliPackageJson;
      let bin = pkg.bin;
      if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
      if (typeof bin === 'string') {
        const p = path.join(LOCAL_CLI_DIR, bin);
        if (fs.existsSync(p)) return p;
      }
    } catch {  }
  }
  if (!GLTF_CLI) return null;
  const pkgDir = path.join(path.dirname(GLTF_CLI), 'node_modules', '@gltf-transform', 'cli');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as CliPackageJson;
    let bin = pkg.bin;
    if (bin && typeof bin === 'object') bin = bin['gltf-transform'] || Object.values(bin)[0];
    if (typeof bin === 'string') {
      const p = path.join(pkgDir, bin);
      if (fs.existsSync(p)) return p;
    }
  } catch {  }
  return null;
}
export const GLTF_CLI_JS = findCliJs();

export const HAS_GLTF_CLI = Boolean(GLTF_CLI_JS || GLTF_CLI);

function findInTools(): string | null {
  const dir0 = process.env.TANYRA_TOOLS_DIR
    || fileURLToPath(new URL('../../.tools/', import.meta.url));
  if (!fs.existsSync(dir0)) return null;
  const stack = [dir0];
  while (stack.length) {
    const dir = stack.pop()!;
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

function findToktx(): string | null {
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

export const TOKTX = findToktx();
const childEnv: NodeJS.ProcessEnv = { ...process.env };
if (TOKTX) {
  const dir = path.dirname(TOKTX);
  const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  if (!(childEnv[pathKey] || '').includes(dir)) childEnv[pathKey] = dir + path.delimiter + (childEnv[pathKey] || '');
}

const CLI_TIMEOUT_MS = 10 * 60_000;
const CLI_MAX_BUFFER = 32 * 1024 * 1024;

export interface TextCollector {
  push(chunk: Buffer): void;
  end(): string;
}

export function makeTextCollector(limit: number = CLI_MAX_BUFFER): TextCollector {
  const decoder = new StringDecoder('utf8');
  const parts: string[] = [];
  let size = 0;
  const add = (text: string) => {
    if (!text) return;
    parts.push(text);
    size += text.length;
    while (parts.length > 1 && size - parts[0]!.length >= limit) size -= parts.shift()!.length;
  };
  const joined = () => {
    const s = parts.join('');
    return s.length > limit ? s.slice(s.length - limit) : s;
  };
  return {
    push(chunk) { add(decoder.write(chunk)); },
    end() { add(decoder.end()); return joined(); },
  };
}

export function runCli(args: string[]): Promise<void> {
  const useNode = Boolean(GLTF_CLI_JS);
  const file = (useNode ? process.execPath : GLTF_CLI) as string;
  const argv = useNode ? [GLTF_CLI_JS!, ...args] : args;

  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, argv, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: !useNode && GLTF_CLI!.endsWith('.cmd'),
    });

    const outBuf = makeTextCollector();
    const errBuf = makeTextCollector();
    child.stdout!.on('data', (c: Buffer) => outBuf.push(c));
    child.stderr!.on('data', (c: Buffer) => errBuf.push(c));

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);

    const settle = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(...a);
    };
    const fail = settle((message: string) => reject(new Error(message)));
    const done = settle(() => resolve());

    child.on('error', (e: Error) => fail(`gltf-transform ${args[0]} failed:\n    ${e.message}`));

    child.on('exit', (code, signal) => {
      const out = outBuf.end();
      const err = errBuf.end();
      if (timedOut) {
        fail(`gltf-transform ${args[0]} превысил ${Math.round(CLI_TIMEOUT_MS / 60_000)} мин и был остановлен`);
        return;
      }
      if (code === 0) { done(); return; }
      const raw = (err + '\n' + out).trim();
      const tail = raw ? raw.split('\n').slice(-10).join('\n    ') : `exit ${code}${signal ? ` (${signal})` : ''}`;
      fail(`gltf-transform ${args[0]} failed:\n    ${tail}`);
    });
  });
}
