import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const analyseScript = path.resolve(__dirname, 'analyse-test-coverage.mjs');
const { BASELINE_ITS, BASELINE_FLAG_COMBOS } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'baselines.json'), 'utf-8'),
);

export function setup() {
  let data;
  try {
    const raw = execFileSync('node', [analyseScript, '--json'], {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `BASELINE GATE: analyse-test-coverage.mjs failed to run.\n` +
      `  Command: node ${analyseScript} --json\n` +
      `  ${err.message}`,
      { cause: err },
    );
  }

  const failures = [];

  if (data.totalIts < BASELINE_ITS) {
    failures.push(
      `Test count ${data.totalIts} < baseline ${BASELINE_ITS}. ` +
      `Someone may have deleted tests without updating the baseline.`,
    );
  }

  const missing = data.modelsMissing || [];
  if (missing.length) {
    failures.push(
      `Committed (REPO_MODELS) models missing from disk: ${missing.join(', ')}. ` +
      `Check fixtures/.gitignore exceptions — a versioned model was lost.`,
    );
  }

  const uncovered = Object.entries(data.modelCoverage || {})
    .filter(([, info]) => !(info.flags || []).length && !info.tests);
  if (uncovered.length) {
    failures.push(
      `Models with zero coverage: ${uncovered.map(([m]) => m).join(', ')}`,
    );
  }

  const uniqFlagCombos = new Set(
    (data.flagCombinations || []).map((fc) => JSON.stringify(fc.flags)),
  );
  if (uniqFlagCombos.size < BASELINE_FLAG_COMBOS) {
    failures.push(
      `Unique flag combos ${uniqFlagCombos.size} < baseline ${BASELINE_FLAG_COMBOS}. ` +
      `A rule may have been renamed or removed.`,
    );
  }

  if (failures.length) {
    throw new Error(`BASELINE FAILED:\n  ${failures.join('\n  ')}`);
  }
}

export function teardown() {}
