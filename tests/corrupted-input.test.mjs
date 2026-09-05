import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpOutDir, cleanupTmpOutDirs } from './helpers/tmp-outdir.mjs';
import { optimizeFile } from '../optimize2.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const FIXTURE_DIR = path.resolve(PROJECT_ROOT, 'fixtures', '_broken_testfiles');

const BROKEN_FILES = {};

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const zeroPath = path.join(FIXTURE_DIR, 'empty.glb');
  fs.writeFileSync(zeroPath, '');
  BROKEN_FILES.empty = zeroPath;

  const randomPath = path.join(FIXTURE_DIR, 'random_bytes.glb');
  fs.writeFileSync(randomPath, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD, 0xFC]));
  BROKEN_FILES.random = randomPath;

  const jsonGarbage = Buffer.from('{"asset":{"version":"2.0"},"SCENES нонсенс\\x00\\x01😀}}}}{{{' + 'a'.repeat(100), 'utf-8');
  const chunkLen = Buffer.alloc(4);
  chunkLen.writeUInt32LE(jsonGarbage.length, 0);
  const glbLen = 12 + 8 + jsonGarbage.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 4, 'utf-8');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(glbLen, 8);
  const brokenJson = Buffer.concat([header, chunkLen, Buffer.from('JSON', 'utf-8'), jsonGarbage]);
  const brokenJsonPath = path.join(FIXTURE_DIR, 'broken_json.glb');
  fs.writeFileSync(brokenJsonPath, brokenJson);
  BROKEN_FILES.brokenJson = brokenJsonPath;

  const emptyChunk = Buffer.alloc(8);
  const headerOnly = Buffer.alloc(12);
  headerOnly.write('glTF', 0, 4, 'utf-8');
  headerOnly.writeUInt32LE(2, 4);
  headerOnly.writeUInt32LE(20, 8);
  const noJsonPath = path.join(FIXTURE_DIR, 'no_json_chunk.glb');
  fs.writeFileSync(noJsonPath, Buffer.concat([headerOnly, emptyChunk]));
  BROKEN_FILES.noJson = noJsonPath;
});

afterAll(() => {
  if (fs.existsSync(FIXTURE_DIR)) {
    for (const f of fs.readdirSync(FIXTURE_DIR)) {
      try { fs.rmSync(path.join(FIXTURE_DIR, f)); } catch {  }
    }
    try { fs.rmSync(FIXTURE_DIR); } catch {  }
  }
});


describe('Corrupted input — graceful failure', () => {
  it('0-byte .glb returns status:fail without crash', async () => {
    const result = await optimizeFile(BROKEN_FILES.empty, { outDir: tmpOutDir(), dryRun: true });
    expect(result.status).toBe('fail');
    expect(result.file.src).toBe(BROKEN_FILES.empty);
    expect(result.file.dst).toBeDefined();
    expect(typeof result.file.dst).toBe('string');
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('random bytes as .glb returns status:fail without crash', async () => {
    const result = await optimizeFile(BROKEN_FILES.random, { outDir: tmpOutDir(), dryRun: true });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('broken JSON chunk returns status:fail without crash', async () => {
    const result = await optimizeFile(BROKEN_FILES.brokenJson, { outDir: tmpOutDir(), dryRun: true });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('GLB header with no JSON chunk returns status:fail', async () => {
    const result = await optimizeFile(BROKEN_FILES.noJson, { outDir: tmpOutDir(), dryRun: true });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});


describe('Corrupted input — nonexistent file', () => {
  it('nonexistent path returns status:fail', async () => {
    const fakePath = path.join(FIXTURE_DIR, 'does_not_exist.glb');
    const result = await optimizeFile(fakePath, { outDir: tmpOutDir(), dryRun: true });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('nonexistent path with advancedFeatures also returns fail', async () => {
    const fakePath = path.join(FIXTURE_DIR, 'no_such_file.glb');
    const result = await optimizeFile(fakePath, {
      outDir: tmpOutDir(),
      advancedFeatures: ['draco'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
  });
});


describe('Corrupted input — edge cases', () => {
  it('corrupted file with advancedFeatures:["ktx2"] — no crash', async () => {
    const result = await optimizeFile(BROKEN_FILES.brokenJson, {
      outDir: tmpOutDir(),
      advancedFeatures: ['ktx2'],
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
  });

  it('corrupted file with dryRun:false — no crash (no disk write attempt)', async () => {
    const result = await optimizeFile(BROKEN_FILES.random, {
      outDir: tmpOutDir(),
      dryRun: false,
      force: true,
    });
    expect(result.status).toBe('fail');
    expect(result.file.written).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('empty file with onProgress callback — no crash', async () => {
    const progressEvents = [];
    const result = await optimizeFile(BROKEN_FILES.empty, {
      outDir: tmpOutDir(),
      dryRun: true,
      onProgress: (ev) => progressEvents.push(ev.type),
    });
    expect(result.status).toBe('fail');
    expect(result.error).toBeDefined();
  });
});


describe('Corrupted input — stats', () => {
  it(`4 broken files created (empty, random, broken JSON, no-JSON)`, () => {
    const count = Object.keys(BROKEN_FILES).length;
    expect(count).toBe(4);
    for (const [name, p] of Object.entries(BROKEN_FILES)) {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThanOrEqual(0);
      console.log(`  • ${name}: ${p} (${fs.statSync(p).size} bytes)`);
    }
  });
});

afterAll(cleanupTmpOutDirs);
