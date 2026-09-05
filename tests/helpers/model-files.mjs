import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.resolve(PROJECT_ROOT, 'fixtures/models');

export const REPO_MODELS = new Set(
  fs.readFileSync(path.resolve(PROJECT_ROOT, 'fixtures/.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => /^!models\/(.+\.(?:glb|gltf))\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => m[1]),
);

export function modelPath(name) {
  return path.resolve(FIXTURES_DIR, name);
}

export function isPresent(name) {
  return REPO_MODELS.has(name) || fs.existsSync(modelPath(name));
}

export function describeLocal(modelName, describeName, fn) {
  const present = isPresent(modelName);
  return (present ? describe : describe.skip)(
    `${describeName} [model=${modelName} ${present ? 'present' : 'missing locally — skipped'}]`,
    fn,
  );
}

export function describeIfModels(required, describeName, fn) {
  const allPresent = required.every(isPresent);
  const missing = required.filter((m) => !isPresent(m));
  const label = allPresent
    ? describeName
    : `${describeName} [skipped: ${missing.length ? missing.join(', ') : 'models missing'}]`;
  return (allPresent ? describe : describe.skip)(label, fn);
}

export function itIfModel(modelName, label, body, timeout) {
  if (isPresent(modelName)) {
    it(`${modelName} — ${label}`, body, timeout);
  } else {
    it.skip(`${modelName} — ${label} [skipped: ${modelName} missing locally]`, () => {}, timeout);
  }
}

export function eachModel(prefix, models, body, timeout) {
  for (const m of models) {
    if (isPresent(m)) {
      it(`${m} — ${prefix}`, () => body(m), timeout);
    } else {
      it.skip(`${m} — ${prefix} [skipped: ${m} missing locally]`, () => {}, timeout);
    }
  }
}
