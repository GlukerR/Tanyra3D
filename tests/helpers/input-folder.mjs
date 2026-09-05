import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const INPUT_DIR = path.resolve(PROJECT_ROOT, 'input');

export const inputExists = fs.existsSync(INPUT_DIR);

export function inputModels({ limit = Infinity, ext = ['.glb', '.gltf'] } = {}) {
  if (!inputExists) return [];
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => ext.some((e) => f.endsWith(e)))
    .sort()
    .slice(0, limit === Infinity ? undefined : limit);
}

export function describeInput(describeName, fn) {
  return (inputExists ? describe : describe.skip)(
    inputExists ? describeName : `${describeName} [skipped: папки input/ нет — чистый клон]`,
    fn,
  );
}
