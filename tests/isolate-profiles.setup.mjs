import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'tanyra3d-tests-profiles');
fs.mkdirSync(dir, { recursive: true });
process.env.TANYRA3D_PROFILES_DIR = dir;
