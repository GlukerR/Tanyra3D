import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE_EXTENSIONS = ['.mts', '.ts', '.mjs', '.js', '.cjs'];

export function sourcePath(moduleName) {
  const base = String(moduleName).replace(/\.(mts|mjs|cjs|ts|js)$/i, '');
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = path.join(ROOT, `${base}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `sourcePath: не найден исходник "${base}" (искали ${SOURCE_EXTENSIONS.join(', ')} в корне проекта)`,
  );
}

export function readSource(moduleName) {
  return fs.readFileSync(sourcePath(moduleName), 'utf8');
}
