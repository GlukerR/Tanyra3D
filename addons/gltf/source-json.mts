import fs from 'node:fs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const GLB_HEADER = 12;
const CHUNK_HEADER = 8;

export type SourceJson = Record<string, unknown>;

export function readSourceJson(src: string): SourceJson | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(src, 'r');
    const head = Buffer.alloc(GLB_HEADER);
    const got = fs.readSync(fd, head, 0, GLB_HEADER, 0);
    if (got === GLB_HEADER && head.readUInt32LE(0) === GLB_MAGIC) {
      const total = head.readUInt32LE(8);
      let off = GLB_HEADER;
      const chunkHead = Buffer.alloc(CHUNK_HEADER);
      while (off + CHUNK_HEADER <= total) {
        if (fs.readSync(fd, chunkHead, 0, CHUNK_HEADER, off) !== CHUNK_HEADER) break;
        const len = chunkHead.readUInt32LE(0);
        const type = chunkHead.readUInt32LE(4);
        if (type === CHUNK_JSON) {
          const chunk = Buffer.alloc(len);
          fs.readSync(fd, chunk, 0, len, off + CHUNK_HEADER);
          return JSON.parse(chunk.toString('utf8'));
        }
        off += CHUNK_HEADER + len;
      }
      return null;
    }
    fs.closeSync(fd); fd = null;
    return JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {  } }
  }
}

export function sourceStamp(src: string): string {
  try {
    const st = fs.statSync(src);
    return `${src}|${st.mtimeMs}|${st.size}`;
  } catch {
    return `${src}|нет`;
  }
}
