import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runOptimize } from './core/engine.mjs';
import { Registry } from './core/registry.mjs';
import gltfAddon from './addons/gltf/index.mjs';
import { GLTF_CLI, GLTF_CLI_JS, TOKTX } from './addons/gltf/tools.mjs';
import { MB } from './addons/gltf/metrics.mjs';

import type { Addon, RunResult, RuleMeta } from './core/types.mjs';

type ConsoleTable = Record<string, (...a: any[]) => void>;

type CliMetrics = { fileBytes: number; gpuBytes: number };

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(BASE_DIR, 'input');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_KEEP_DAYS = 30;

const registry = new Registry().register(gltfAddon as unknown as Addon);

export const VERSION = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8')).version;

export function listRules(): RuleMeta[] {
  const out: RuleMeta[] = [];
  for (const addon of registry.addons()) {
    for (const r of addon.rules) {
      out.push({ ...r.meta, runAfter: [...(r.meta.runAfter || [])], touches: [...(r.meta.touches || [])] });
    }
  }
  return out;
}

export function exclusiveGroups(): Array<{ id: string; members: string[] }> {
  const out: Array<{ id: string; members: string[] }> = [];
  for (const addon of registry.addons()) {
    if (typeof addon.exclusiveGroups !== 'function') continue;
    for (const g of addon.exclusiveGroups()) out.push({ ...g, members: [...g.members] });
  }
  return out;
}

export function textureSlots(): Array<{ slot: string; pattern: string; flags: string }> {
  const out: Array<{ slot: string; pattern: string; flags: string }> = [];
  for (const addon of registry.addons()) {
    if (typeof addon.textureSlots !== 'function') continue;
    for (const s of addon.textureSlots()) out.push({ ...s });
  }
  return out;
}

export async function optimizeFile(srcPath: string, opts: Record<string, unknown> = {}): Promise<RunResult> {
  let addon: Addon;
  try {
    addon = registry.resolve(srcPath);
  } catch (e: any) {
    return {
      status: 'fail' as const,
      file: { src: path.resolve(String(srcPath)), dst: null, written: false, reportPath: null },
      findings: [], skipped: [], applied: [], validation: [], metrics: { before: null, after: null },
      error: e && e.message ? e.message : String(e),
    };
  }
  return runOptimize(addon, srcPath, opts);
}

export async function inspectFile(srcPath: string) {
  const addon = registry.resolve(srcPath);
  if (typeof addon.inspect !== 'function') {
    return { format: null, asset: {}, extensions: [], metadata: null, metrics: null, validation: [] };
  }
  return addon.inspect(srcPath);
}

export async function exportJson(srcPath: string) {
  const addon = registry.resolve(srcPath);
  if (typeof addon.toJSON !== 'function') throw new Error('This format does not support JSON export.');
  return addon.toJSON(srcPath);
}

function initCliLogging(opts: { dryRun?: boolean } & Record<string, unknown>) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
  const logFile = path.join(LOG_DIR, `run_${stamp}.log`);
  const logLines = [`=== Tanyra3D · run ${new Date().toISOString()} ===`, `argv: ${process.argv.slice(2).join(' ') || '(no arguments)'}`];
  for (const m of ['log', 'error', 'warn']) {
    const orig = (console as unknown as ConsoleTable)[m]!.bind(console);
    (console as unknown as ConsoleTable)[m] = (...a: any[]) => {
      logLines.push(a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || String(x))).join(' '));
      orig(...a);
    };
  }
  const flushLog = () => {
    try { fs.writeFileSync(logFile, logLines.join('\n') + '\n', 'utf8'); } catch {  }
  };
  process.on('exit', flushLog);

  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.log')) continue;
      const p = path.join(LOG_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > LOG_KEEP_DAYS * 24 * 3600 * 1000) fs.rmSync(p);
    }
  } catch {  }

  logLines.push(`node: ${process.version} | CLI: ${GLTF_CLI_JS || GLTF_CLI || 'not found'} | toktx: ${(opts.noKtx ? null : TOKTX) || 'not found'}`);
}

function parseArgv(rawArgv: string[]) {
  const argv = rawArgv.map((a) => a.toLowerCase());
  const has = (f: string) => argv.includes(f);
  const advancedFeatures: string[] = [];

  const preset = !(has('--none') || has('--passthrough'));
  const draco = has('draco') || has('--draco');
  if (preset) {
    advancedFeatures.push('safe', draco ? 'draco' : 'meshopt');
    if (!has('--keep-parts')) advancedFeatures.push('join');
  } else if (draco) {
    advancedFeatures.push('draco');
  }
  if (has('--ktx2')) advancedFeatures.push('ktx2');
  if (has('--strip-vertex-colors')) advancedFeatures.push('strip-colors');

  return {
    advancedFeatures: [...new Set(advancedFeatures)],
    keepParts: argv.includes('--keep-parts'),
    ...(argv.includes('--no-ktx') ? { noKtx: true } : {}),
    ...(has('--uastc') ? { texMode: 'uastc' } : has('--etc1s') ? { texMode: 'mixed' } : {}),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  const OPTS = gltfAddon.normalizeOpts(parseArgv(process.argv.slice(2)));
  initCliLogging(OPTS);
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const accept = new RegExp(`\\.(${gltfAddon.formats.join('|')})$`, 'i');
  const files = fs.readdirSync(INPUT_DIR).filter((f) => accept.test(f)).sort();
  if (!files.length) {
    const list = gltfAddon.formats.map((e) => `.${e}`).join(', ');
    console.log(`No model files in input/ (${list}). Put models here:\n  ${INPUT_DIR}`);
    return;
  }

  await gltfAddon.createIO();

  console.log(`Codec: ${OPTS.codec}`
    + (OPTS.noKtx ? ' | no KTX2' : ` | textures: ${OPTS.texMode}`)
    + (OPTS.keepParts ? ' | no join' : '')
    + (OPTS.stripColors ? ' | strip-vertex-colors' : '')
    + (OPTS.dryRun ? ' | DRY-RUN (no .glb written)' : '')
    + (OPTS.advancedFeatures.length ? ` | extensions: ${OPTS.advancedFeatures.join(', ')}` : ' | basic only')
    + (OPTS.noKtx || TOKTX ? '' : ' | toktx NOT found'));
  console.log(`Files: ${files.length}\n`);

  const pct = (b: number, a: number) => (b ? (a <= b ? `−${((1 - a / b) * 100).toFixed(0)}%` : `+${((a / b - 1) * 100).toFixed(0)}%`) : '—');
  let ok = 0, skip = 0, fail = 0;
  for (const f of files) {
    try {
      const dstName = f.replace(/\.gltf$/i, '.glb');
      if (!OPTS.dryRun && fs.existsSync(path.join(OUTPUT_DIR, dstName))) {
        console.log(`[SKIP] ${f} — already in output/`);
        skip++;
      } else {
        console.log(`[WORKING] ${f}`);
        const r = await optimizeFile(path.join(INPUT_DIR, f), { ...OPTS, outDir: OUTPUT_DIR, log: (m: string) => console.log(m) });
        const reportName = r.file.reportPath ? path.basename(r.file.reportPath) : '';
        if (r.status === 'ok') {
          const b = r.metrics.before as CliMetrics, a = r.metrics.after as CliMetrics;
          const tag = OPTS.dryRun ? '[DRY-RUN]' : '[DONE]';
          console.log(`${tag} ${dstName}: file ${MB(b.fileBytes)} → ${MB(a.fileBytes)} MB (${pct(b.fileBytes, a.fileBytes)}), VRAM ${MB(b.gpuBytes)} → ${MB(a.gpuBytes)} MB (${pct(b.gpuBytes, a.gpuBytes)})${OPTS.dryRun ? ' — file NOT written' : ''}`);
          console.log(`         report: output/${reportName}`);
          ok++;
        } else if (r.status === 'skip') {
          console.log(`[SKIP] ${f} — already in output/`);
          skip++;
        } else if (r.error) {
          fail++;
          console.error(`[ERROR] ${f}: ${r.error}`);
        } else {
          fail++;
          const where = r.file && r.file.written ? `.glb written to ${r.file.dst}` : '.glb NOT written';
          console.error(`[ERROR] ${f}: validation failed — ${where}; see the report before using it`);
          console.log(`         report: output/${reportName}`);
        }
      }
    } catch (e: any) {
      fail++;
      console.error(`[ERROR] ${f}: ${e.message || e}`);
    }
    console.log();
  }
  console.log(`Summary: done ${ok}, skipped ${skip}, errors ${fail}`);
}

function isDirectCliRun() {
  if (!process.argv[1]) return false;
  try {
    const argUrl = pathToFileURL(path.resolve(process.argv[1])).href;
    return process.platform === 'win32'
      ? argUrl.toLowerCase() === import.meta.url.toLowerCase()
      : argUrl === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectCliRun()) {
  main().catch((e) => { console.error('[FATAL ERROR]', e && e.stack ? e.stack : e); process.exit(1); });
}
