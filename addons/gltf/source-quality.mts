const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

export type CeilingSource = 'lossless' | 'jpeg' | 'probe' | 'unknown';

export interface Ceiling {
  q: number | null;
  how: CeilingSource;
}

export function jpegQuality(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length - 4) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2) return null;
    if (marker === 0xdb) {
      const table = bytes.subarray(i + 5, i + 5 + 64);
      if (table.length < 64) return null;
      let sum = 0;
      for (let k = 0; k < 64; k++) sum += (table[k]! * 100 - 50) / STD_LUMA[k]!;
      const scale = sum / 64;
      const q = scale <= 100 ? 100 - scale / 2 : 5000 / scale;
      return Math.min(100, Math.max(1, Math.round(q)));
    }
    i += 2 + len;
  }
  return null;
}

function isLosslessSource(bytes: Uint8Array): boolean {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length > 16
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c;
  }
  return false;
}

export function readCeiling(bytes: Uint8Array, mime: string): Ceiling {
  if (isLosslessSource(bytes)) return { q: null, how: 'lossless' };
  const jpeg = jpegQuality(bytes);
  if (jpeg !== null) return { q: jpeg, how: 'jpeg' };
  if (isWebpContainer(bytes) || mime === 'image/webp') return { q: null, how: 'probe' };
  return { q: null, how: 'unknown' };
}

function isWebpContainer(bytes: Uint8Array): boolean {
  return bytes.length > 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export type EncodeAt = (quality: number) => Promise<{ byteLength: number }>;

const PROBE_STEPS = 5;

export async function probeWebpCeiling(sourceBytes: number, encodeAt: EncodeAt): Promise<number> {
  let lo = 30;
  let hi = 100;
  let best = 100;
  for (let step = 0; step < PROBE_STEPS && lo <= hi; step++) {
    const mid = Math.round((lo + hi) / 2);
    const out = await encodeAt(mid);
    best = mid;
    if (out.byteLength > sourceBytes) hi = mid - 1; else lo = mid + 1;
  }
  return Math.min(100, Math.max(1, best));
}

export function targetQuality(ceiling: Ceiling, share: number): number {
  const base = ceiling.q ?? 100;
  return Math.min(100, Math.max(1, Math.round(base * share / 100)));
}
