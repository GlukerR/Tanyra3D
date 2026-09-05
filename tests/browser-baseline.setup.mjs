import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export function setup() {
  const failures = [];

  const corpusPath = path.resolve(__dirname, 'golden-corpus.test.mjs');
  if (!existsSync(corpusPath)) {
    failures.push(`File not found: tests/golden-corpus.test.mjs`);
  } else {
    const size = statSync(corpusPath).size;
    if (size < 10_000) {
      failures.push(
        `tests/golden-corpus.test.mjs is suspiciously small ` +
        `(${size} bytes) — may be truncated or empty`,
      );
    }
  }

  if (!existsSync(path.resolve(__dirname, 'baselines.json'))) {
    failures.push('File not found: tests/baselines.json');
  }

  const modelsDir = path.resolve(projectRoot, 'fixtures/models');
  if (!existsSync(modelsDir)) {
    failures.push('fixtures/models/ directory not found');
  } else {
    const glbFiles = readdirSync(modelsDir).filter((f) => f.endsWith('.glb'));
    if (!glbFiles.length) {
      failures.push('No .glb files found in fixtures/models/ — viewer tests have nothing to render');
    }
  }

  if (failures.length) {
    throw new Error(`BROWSER BASELINE FAILED:\n  ${failures.join('\n  ')}`);
  }
}

export function teardown() {}
