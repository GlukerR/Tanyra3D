// addons/gltf/messages/en.mjs — английский каталог сообщений правил glTF-аддона.
// Единственный каталог на данный момент. Ключи (messageId) возвращают правила из
// rules.mjs вместе с data; ядро рендерит их через core/i18n.mjs перед записью в отчёт.
// Второй язык = второй файл (ru.mjs) с теми же ключами — правила не переписываются.
//
// Значение — функция (data → строка). where-хелпер строит метку «SEM (mesh "name")».

const where = ({ sem, mesh }) => `${sem} (mesh "${mesh || '—'}")`;

export default {
  // --- structure/dedup ---
  'dedup.safe': () => 'merging identical resources is structurally safe',
  'dedup.found.textures': ({ n }) => `duplicate textures: ${n}`,
  'dedup.found.materials': ({ n }) => `duplicate materials: ${n}`,
  'dedup.found.accessors': ({ n }) => `duplicate accessors: ${n}`,
  'dedup.done.textures': ({ n }) => `Merged duplicate textures (${n})`,
  'dedup.done.materials': ({ n }) => `Merged duplicate materials (${n})`,
  'dedup.done.accessors': ({ n }) => `Merged duplicate accessors (${n})`,

  // --- structure/prune-unused ---
  'prune.safe': () => 'only resources with no remaining references are removed',
  'prune.found.attribute': ({ sem }) => `attribute ${sem} is not used by any material`,
  'prune.found.textures': ({ n }) => `unused textures: ${n}`,
  'prune.found.materials': ({ n }) => `unused materials: ${n}`,
  'prune.found.emptySkins': ({ n }) => `empty skins (meshes have no JOINTS/WEIGHTS): ${n}`,
  'prune.done.attribute': ({ sem }) => `Attribute ${sem}: not used by any material — removed (prune)`,
  'prune.done.textures': ({ n }) => `Textures: removed ${n} unused`,
  'prune.done.materials': ({ n }) => `Materials: removed ${n} unused`,
  'prune.done.emptySkins': ({ n }) => `Removed ${n} empty skins — no deformation, animation runs through the node hierarchy`,

  // --- attributes/vertex-colors ---
  'vertexColors.safe': () => 'white channels are removed provably safely; painted ones only via flag',
  'vertexColors.found.white': (d) => `${where(d)}: all values white — no visual effect`,
  'vertexColors.found.painted': (d) => `${where(d)}: real vertex painting`,
  'vertexColors.done.white': (d) => `${where(d)}: all values white — removed, look unchanged`,
  'vertexColors.stripped': (d) => `${where(d)}: PAINTED, removed via --strip-vertex-colors flag — look may change`,
  'vertexColors.skipped': (d) => `${where(d)}: real painting — NOT removed, affects the look. Force with: --strip-vertex-colors`,

  // --- geometry/weld ---
  'weld.safe': () => 'only identical vertices are welded',
  'weld.found': ({ n }) => `identical vertices: ${n}`,
  'weld.done': ({ before, after }) => `Vertex weld: ${before} → ${after}`,

  // --- geometry/degenerate-triangles ---
  'degenerate.safe': () => 'a triangle with a repeated index has zero area and is not drawn',
  'degenerate.found': ({ n }) => `degenerate triangles (zero area): ${n}`,
  'degenerate.done': ({ n }) => `Degenerate triangles: removed ${n} (zero area, had no render effect)`,

  // --- geometry/orphan-vertices ---
  'orphan.unavailable': () => 'compactPrimitive is unavailable in this @gltf-transform/functions version — pass skipped',
  'orphan.safe': () => 'vertices addressed by no index and not drawn',
  'orphan.found': ({ n }) => `orphan vertices: ${n}`,
  'orphan.done': ({ n }) => `Orphan vertices: removed ${n} (addressed by no index, not drawn)`,

  // --- scene/join ---
  'join.safe': () => 'model is static, separate parts not needed (otherwise --keep-parts)',
  'join.found': ({ drawCalls, nodes }) => `extra draw calls / nodes: draw calls ${drawCalls}, nodes ${nodes}`,
  'join.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Meshes joined (flatten+join): draw calls ${dcBefore} → ${dcAfter}, nodes ${nodesBefore} → ${nodesAfter}`,

  // --- structure/prune-final ---
  'pruneFinal.safe': () => 'only resources orphaned by previous fixes are removed',
  'pruneFinal.done': ({ n }) => `Cleanup (prune): removed ${n} orphaned accessors`,

  // --- textures/ktx2 ---
  'ktx2.noTools': () => 'toktx or gltf-transform CLI not found — textures left in their original format',
  'ktx2.safe': () => 'UASTC --level 2 --zstd 18 without RDO — near-lossless, user\'s choice',
  'ktx2.skipped.already': ({ name }) => `Texture "${name}": already KTX2 — not re-encoded (no extra loss)`,
  'ktx2.done.toPng': ({ name, mime }) => `Texture "${name}": ${mime} → PNG (lossless, for toktx)`,
  'ktx2.found': ({ n }) => `textures not in KTX2: ${n}`,
  'ktx2.done.color': ({ n, list }) => `Color textures → KTX2/ETC1S, quality 255 (${n}: ${list}) — compact in file and in VRAM`,
  'ktx2.done.data': ({ n, list }) => `Data textures → KTX2/UASTC --level 2 --zstd 18 (${n}: ${list}) — normals/ORM without ETC1S artifacts`,
  'ktx2.done.uastc': ({ n }) => `Textures → KTX2/UASTC: ${n} (--level 2 --zstd 18, no RDO; --uastc mode)`,
  'ktx2.log.skipped': () => '        all textures are already KTX2 or absent — encoding skipped',
  'ktx2.log.encoding': ({ n, mixed }) => `        KTX2 encoding (${n}, mode ${mixed ? 'mixed: ETC1S+UASTC' : 'uastc'})`,

  // --- geometry/compress ---
  'compress.safe': () => 'compression packs vertex data, polygon count does not change',
  'compress.done': ({ codec }) => `Geometry compressed (${codec}) — polygon count unchanged`,
};
