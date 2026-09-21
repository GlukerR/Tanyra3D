const fs = require('node:fs');
const path = require('node:path');

const MODEL_RE = /\.gltf$/i;
const MAX_FILES = 256;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;

function insideDir(dir, full) {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return full.startsWith(prefix);
}

function readNeighbors(modelPath, names) {
  if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath) || !MODEL_RE.test(modelPath)) return [];
  if (!Array.isArray(names)) return [];
  const dir = path.resolve(path.dirname(modelPath));
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { return []; }
  const out = [];
  let total = 0;
  for (const name of names.slice(0, MAX_FILES)) {
    if (typeof name !== 'string' || !name || /^[a-z][a-z0-9+.-]*:/i.test(name)) continue;
    let rel = name;
    try { rel = decodeURIComponent(name); } catch {  }
    if (path.isAbsolute(rel)) continue;
    const full = path.resolve(dir, rel);
    if (!insideDir(dir, full)) continue;
    // reject symlink/junction escape
    let real;
    try { real = fs.realpathSync(full); } catch { continue; }
    if (!insideDir(realDir, real)) continue;
    let st;
    try { st = fs.statSync(real); } catch { continue; }
    if (!st.isFile() || total + st.size > MAX_TOTAL) continue;
    total += st.size;
    out.push({ name, data: fs.readFileSync(real) });
  }
  return out;
}

module.exports = { readNeighbors };
