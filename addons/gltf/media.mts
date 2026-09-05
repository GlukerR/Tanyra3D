export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

export const TYPE_BY_SIZE: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

export const TEXTURE_SLOTS: Array<{ slot: string; re: RegExp }> = [
  { slot: 'baseColor', re: /(basecolor|base_color|albedo|diffuse|_col(our)?[._-]|_d\.)/i },
  { slot: 'normal', re: /(normal|_nrm[._-]|_n\.)/i },
  { slot: 'roughness', re: /(rough|_rgh[._-])/i },
  { slot: 'metallic', re: /(metal|_mtl[._-])/i },
  { slot: 'occlusion', re: /((^|[._-])ao([._-]|$)|occlusion|ambient)/i },
  { slot: 'emissive', re: /(emissi|_emit[._-])/i },
];

export function textureSlotsWire(): Array<{ slot: string; pattern: string; flags: string }> {
  return TEXTURE_SLOTS.map(({ slot, re }) => ({ slot, pattern: re.source, flags: re.flags }));
}
