import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = [];

export function tmpOutDir(prefix = 'tests-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTmpOutDirs() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
