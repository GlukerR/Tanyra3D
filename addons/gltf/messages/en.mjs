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
  // Множественный вариант — отдельным ключом, а не списком в той же фразе.
  'prune.found.attributes': ({ n, list }) => `${n} attribute${n === 1 ? ' is' : 's are'} not used by any material (${list})`,
  'prune.found.textures': ({ n }) => `unused textures: ${n}`,
  'prune.found.materials': ({ n }) => `unused materials: ${n}`,
  'prune.found.emptySkins': ({ n }) => `empty skins (meshes have no JOINTS/WEIGHTS): ${n}`,
  'prune.done.attribute': ({ sem }) => `Attribute ${sem}: not used by any material — removed (prune)`,
  'prune.done.attributes': ({ n, list }) => `Removed ${n} unused attribute${n === 1 ? '' : 's'} (${list})`,
  'prune.done.textures': ({ n }) => `Textures: removed ${n} unused`,
  'prune.done.materials': ({ n }) => `Materials: removed ${n} unused`,
  'prune.done.emptySkins': ({ n }) => `Removed ${n} empty skin${n === 1 ? '' : 's'} — no deformation, animation runs through the node hierarchy`,

  // --- attributes/vertex-colors ---
  'vertexColors.safe': () => 'white channels are removed provably safely; painted ones only via flag',
  'vertexColors.found.white': (d) => `${where(d)}: all values white — no visual effect`,
  'vertexColors.found.painted': (d) => `${where(d)}: real vertex painting`,
  'vertexColors.done.white': (d) => `${where(d)}: all values white — removed, look unchanged`,
  'vertexColors.stripped': (d) => `${where(d)}: PAINTED, removed via --strip-vertex-colors flag — look may change`,
  'vertexColors.skipped': (d) => `${where(d)}: real painting — NOT removed, affects the look. Force with: --strip-vertex-colors`,
  // Те же сообщения, когда мешей несколько.
  'vertexColors.found.white.many': ({ sem, n, list }) => `${sem}: all values white — no visual effect; ${n} meshes (${list})`,
  'vertexColors.found.painted.many': ({ sem, n, list }) => `${sem}: real vertex painting; ${n} meshes (${list})`,
  'vertexColors.done.white.many': ({ sem, n, list }) => `${sem}: all values white — removed, look unchanged; ${n} meshes (${list})`,
  'vertexColors.stripped.many': ({ sem, n, list }) => `${sem}: PAINTED, removed via --strip-vertex-colors flag — look may change; ${n} meshes (${list})`,
  'vertexColors.skipped.many': ({ sem, n, list }) => `${sem}: real painting — NOT removed, affects the look. Force with: --strip-vertex-colors; ${n} meshes (${list})`,

  // --- skin/joints-dedupe, skin/weights-normalize, skin/zero-weight-joints ---
  // Три правила чинят то, на что жалуется валидатор Khronos. Ни одна строка не называет
  // код замечания: человеку нужно, ЧТО с моделью, а код он и так увидит в проверке.
  'skinJoints.safe': () => 'the shares of one and the same bone are added up — the total influence on the vertex does not change',
  'skinJoints.found.duplicate': ({ n }) => `vertices where one bone is listed twice: ${n}`,
  'skinJoints.done.duplicate': ({ n, joints }) => `Merged the repeated bone on ${n} vertex${n === 1 ? '' : 'es'} (${joints} duplicate${joints === 1 ? '' : 's'})`,

  'skinWeights.safe': () => 'the shares are divided by their sum — the proportion between bones is preserved',
  'skinWeights.found': ({ n }) => `vertices whose bone shares do not add up to one: ${n}`,
  'skinWeights.done': ({ n }) => `Bone shares brought to one on ${n} vertex${n === 1 ? '' : 'es'} — the mesh no longer shrinks toward the origin`,
  'skinWeights.skipped.zeroSum': ({ n }) => `${n} vertex${n === 1 ? ' has' : 'es have'} no bone influence at all — left as is: which bone should move them is known only to the model's author`,

  'skinZeroJoints.safe': () => 'a bone with zero share affects nothing — only the reference is cleared, the shares stay untouched',
  'skinZeroJoints.found': ({ n }) => `bone references with zero share: ${n}`,
  'skinZeroJoints.done': ({ n, vertices }) => `Cleared ${n} bone reference${n === 1 ? '' : 's'} with zero share on ${vertices} vertex${vertices === 1 ? '' : 'es'} — the look is unchanged, the file compresses better`,

  // --- scene/skinned-mesh-root ---
  'skinnedRoot.safe': () => 'the node is moved only when every transform above it is an identity one — the scene keeps every number it had',
  'skinnedRoot.found': ({ n }) => `skinned meshes sitting outside the scene root: ${n}`,
  'skinnedRoot.done': ({ n }) => `Moved ${n} skinned mesh${n === 1 ? '' : 'es'} to the scene root — the pose is unchanged, the viewer no longer warns`,
  'skinnedRoot.skipped.notProvable': ({ n }) => `${n} skinned mesh${n === 1 ? '' : 'es'} left where ${n === 1 ? 'it is' : 'they are'}: something above ${n === 1 ? 'it' : 'them'} moves or scales, and re-parenting would mean recomputing the pose`,

  // --- textures/resize ---
  'resize.safe': () => 'only textures larger than the chosen size are shrunk; proportions are kept',
  'resize.found': ({ n, px }) => `textures larger than ${px} px: ${n}`,
  'resize.done': ({ n, px, kb }) => `Shrunk ${n} texture${n === 1 ? '' : 's'} to ${px} px on the longer side (${kb} KB lighter). The discarded pixels are gone — keep the original elsewhere`,
  'resize.skipped.compressed': ({ n }) => `${n} texture${n === 1 ? ' was' : 's were'} left as ${n === 1 ? 'it is' : 'they are'} — already compressed for the video card (KTX2 and the like). Shrinking those means unpacking and repacking, losing quality twice: shrink first, compress after`,
  'resize.skipped.unreadable': ({ n }) => `${n} texture${n === 1 ? '' : 's'} skipped — the image size could not be read`,
  'resize.skipped.failed': ({ n }) => `${n} texture${n === 1 ? '' : 's'} not shrunk — the image could not be re-encoded`,

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

  // Отказ структурных правил на модели с неизвестным расширением.
  'unsupportedExtension.refuse': ({ list }) =>
    `the model uses ${list}, which this pipeline does not understand. Such an extension can address properties by index (KHR_animation_pointer does), so removing or renumbering anything would silently break it — structural changes are refused. Compression and texture options still work.`,

  // --- scene/join ---
  'join.safe': () => 'model is static, separate parts not needed (otherwise --keep-parts)',
  'join.found': ({ drawCalls, nodes }) => `extra draw calls / nodes: draw calls ${drawCalls}, nodes ${nodes}`,
  'join.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Meshes joined (flatten+join): draw calls ${dcBefore} → ${dcAfter}, nodes ${nodesBefore} → ${nodesAfter}`,
  // Цена объединения на модели с общей геометрией. Формулировка без обвинений:
  // человек выбрал опцию сознательно, ему нужна цифра и подсказка, а не выговор.
  'join.keptShared': ({ meshes }) =>
    `Left alone: ${meshes} mesh(es) shared by several nodes. Joining them would bake the same geometry into a separate copy per node — the file would grow instead of shrinking. Turn on GPU instancing to cut their draw calls without the extra bytes.`,
  // Цена сохранённого выбора цветов. Слово «варианты» — из интерфейса самой модели
  // (так их называет художник в Blender), идентификатор расширения не упоминается.
  'join.keptVariants': ({ meshes }) =>
    `Left alone: ${meshes} mesh(es) that carry material variants — the alternative colours and finishes the model can switch between. Joining them would merge the parts the switch relies on, and the choice would silently stop working. The price is a few extra draw calls.`,
  // 'join.expandedShared' removed 2026-08-01 together with the record itself
  // (TESTBUG-009): shared meshes no longer reach join at all, and the growth it
  // measured was undone by the final cleanup right after — the line called geometry
  // "copied" while it ended up a third lighter. join.keptShared explains the rest.

  // --- scene/instance ---
  // The extension name (EXT_mesh_gpu_instancing) is deliberately absent here —
  // It shows up in metadata and in the validator anyway, and in a report line it
  // only gets in the way. What matters is fewer draw calls.
  'instance.found': () => 'repeated meshes — they can be drawn with one command instead of one per copy',
  'instance.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Repeats collected into instances: draw calls ${dcBefore} → ${dcAfter}, nodes ${nodesBefore} → ${nodesAfter}`,
  'instance.skipped.nothing': () => 'no repeated meshes — nothing to collect into instances',

  // --- animation/resample ---
  'resample.done': ({ pct }) => `Redundant keyframes removed: animation data ${pct}% lighter — the motion is unchanged`,
  'resample.skipped.noAnimations': () => 'the model has no animations',
  'resample.skipped.minimal': () => 'no redundant keyframes — the animation is already minimal',

  'ktx2.grewFile': ({ beforeKb, afterKb, pct }) =>
    `KTX2 made the textures heavier: ${beforeKb} KB → ${afterKb} KB (+${pct}%). `
    + `PNG and JPEG are compressed for transfer and unpacked before they reach the GPU; KTX2 stays compressed in video memory. `
    + `On a large texture it wins on both — on a small one the container overhead outweighs the picture itself. `
    + `Video memory still went down, so keep KTX2 only if that is what you are optimising for.`,

  // --- structure/prune-final ---
  'pruneFinal.safe': () => 'only resources orphaned by previous fixes are removed',
  'pruneFinal.done': ({ n }) => `Cleanup (prune): removed ${n} orphaned accessor${n === 1 ? '' : 's'}`,

  // --- textures/ktx2 ---
  'ktx2.noTools': () => 'toktx or gltf-transform CLI not found — textures left in their original format',
  'ktx2.safe': () => 'UASTC --level 2 --zstd 18 without RDO — near-lossless, user\'s choice',
  'ktx2.skipped.already': ({ name }) => `Texture "${name}": already KTX2 — not re-encoded (no extra loss)`,
  'ktx2.skipped.already.many': ({ n }) => `${n} textures are already KTX2 — not re-encoded (no extra loss)`,
  'ktx2.skipped.toPngFailed': ({ n }) => `${n} texture${n === 1 ? '' : 's'} could not be converted to PNG — left in the original format`,
  // Одной строкой на все текстуры, а не строкой на каждую. Экспортёры почти никогда
  // не именуют текстуры, поэтому тринадцать одинаковых строк вида `Texture "—": …`
  // не сообщали ничего, кроме своего количества.
  'ktx2.done.toPng': ({ n, from }) => `${n} texture${n === 1 ? '' : 's'} converted ${from} → PNG (lossless, required by toktx)`,
  'ktx2.found': ({ n }) => `${n} incoming texture${n === 1 ? ' was' : 's were'} not KTX2 — these are the ones being encoded`,
  // Список имён — только если имена есть. Раньше печаталось `(5: —, —, —, —, —)`:
  // пять прочерков вместо имён, потому что текстуры безымянные. Читателю это
  // сообщало ровно ничего, а строку удлиняло вдвое.
  'ktx2.done.color': ({ n, list }) => `${n} color texture${n === 1 ? '' : 's'} → KTX2/ETC1S, quality 255${list ? ` (${list})` : ''} — compact in file and in VRAM`,
  'ktx2.done.data': ({ n, list }) => `${n} data texture${n === 1 ? '' : 's'} → KTX2/UASTC --level 2 --zstd 18${list ? ` (${list})` : ''} — normals/ORM without ETC1S artifacts`,
  'ktx2.done.uastc': ({ n }) => `Textures → KTX2/UASTC: ${n} (--level 2 --zstd 18, no RDO; --uastc mode)`,
  'ktx2.relabeled': ({ n, list }) => `${n} data texture${n === 1 ? '' : 's'} relabeled to linear (${list}) — the encoder marked them sRGB, which darkens occlusion/roughness at render time`,
  'ktx2.log.skipped': () => '        all textures are already KTX2 or absent — encoding skipped',
  'ktx2.log.encoding': ({ n, mixed }) => `        KTX2 encoding (${n}, mode ${mixed ? 'mixed: ETC1S+UASTC' : 'uastc'})`,

  // --- textures/webp ---
  'webp.safe': () => 'color textures at quality 90, data textures (normal/occlusion/roughness) lossless; anything that gets heavier is left as it was',
  'webp.skipped.already': ({ name }) => `Texture "${name}": already WebP — not re-encoded (no extra loss)`,
  'webp.skipped.already.many': ({ n }) => `${n} textures are already WebP — not re-encoded (no extra loss)`,
  'webp.skipped.format': ({ name, mime }) => `Texture "${name}": ${mime} is not converted to WebP — it is already a GPU format`,
  'webp.skipped.format.many': ({ n, mime }) => `${n} textures in ${mime} — not converted to WebP, that is already a GPU format`,
  // Separate from the GPU-format case: AVIF, BMP, TGA unpack to the same
  // uncompressed image PNG does — the reason is simply that we do not re-encode them.
  'webp.skipped.unsupported': ({ name, mime }) => `Texture "${name}": we do not re-encode ${mime} — left as it was`,
  'webp.skipped.unsupported.many': ({ n, mime }) => `${n} textures in ${mime} — we do not re-encode that format, left as they were`,
  'webp.skipped.noMime': ({ name }) => `Texture "${name}": the model does not state its format — not encoded blindly`,
  'webp.skipped.noMime.many': ({ n }) => `${n} textures with no stated format — not encoded blindly`,
  'webp.skipped.jpegData': ({ name }) => `Data texture "${name}" arrived as JPEG — left as it is: lossless would make it several times heavier, and data textures must not be encoded lossily`,
  'webp.skipped.jpegData.many': ({ n }) => `${n} data textures arrived as JPEG — left as they are: lossless would make them several times heavier, and data textures must not be encoded lossily`,
  'webp.skipped.failed': ({ name, reason }) => `Texture "${name}" could not be encoded (${reason}) — left as it was, the build was not interrupted`,
  'webp.keptOriginal': ({ n }) => `${n} texture${n === 1 ? '' : 's'} kept in the original format — WebP came out heavier, and WebP only ever wins on file size`,
  'webp.found': ({ n }) => `${n} texture${n === 1 ? ' is' : 's are'} PNG or JPEG — these are the ones being encoded`,
  'webp.done.color': ({ n }) => `${n} color texture${n === 1 ? '' : 's'} → WebP, quality 90 — smaller file, video memory unchanged`,
  'webp.done.data': ({ n }) => `${n} data texture${n === 1 ? '' : 's'} → WebP lossless — normals and roughness are numbers, lossy chroma would distort them`,

  'prune.refuse.wouldEmptyScene': ({ n }) => `the model has ${n} node${n === 1 ? '' : 's'} and no shapes at all — cleanup would take the whole scene away, so it is left alone`,

  // --- reversibility notes (meta.reversalNoteKey) ---
  // Until 2026-08-04 these were hard-coded English strings inside rule meta —
  // that broke the "no ready strings in code" rule in the rule's own description.
  // Now they are keys like everything else.
  'reversal.join': () => 'Node hierarchy and separate parts are merged — they cannot be restored from the result. To keep parts, leave joining off.',
  'reversal.instance': () => 'Instancing can be expanded back to individual nodes.',
  'reversal.ktx2': () => 'KTX2 can be unpacked back to PNG/WebP with a small quality loss.',
  'reversal.webp': () => 'WebP can be decoded back to PNG, but lossy re-encoding is not undone.',
  'reversal.compress': () => 'Compressed geometry unpacks back to the standard format without data loss.',
  'reversal.quantize': () => 'Quantized geometry unpacks back to float32, but the precision dropped in quantization does not come back.',

  // --- frame of the downloadable report (.md) ---
  // Headings and table labels. They used to be hard-coded English inside writeReport,
  // so a Russian reader got a report half in a foreign language.
  'report.title': ({ name }) => `Optimization report — ${name}`,
  'report.meta': ({ date, codec, tier, flags }) => `Date: ${date} · codec: ${codec} · autofix: up to "${tier}"${flags}`,
  'report.section.found': () => 'Found (issues)',
  'report.section.skipped': () => 'Skipped (and why)',
  'report.section.applied': () => 'Applied',
  'report.section.validation': () => 'Validation',
  'report.section.improvements': () => 'Estimated improvements',
  'report.found.none': () => 'no individual findings (structural cleanup with nothing to note)',
  'report.none': () => 'none',
  'report.dryRun': () => '**Dry-run mode** — the .glb was not written; the report shows what WOULD have been done (all phases ran in memory, numbers are exact).',
  'report.notWritten': () => '**The .glb was NOT written** — validation failed (see Validation below).',
  'report.col.metric': () => 'Metric',
  'report.col.before': () => 'Before',
  'report.col.after': () => 'After',
  'report.metric.file': () => 'File',
  'report.metric.gpuBytes': () => 'Texture VRAM (GPU)',
  'report.metric.textureBytes': () => 'Texture weight in file',
  'report.metric.drawCalls': () => 'Draw calls (primitives)',
  'report.metric.triangles': () => 'Triangles',
  'report.metric.vertices': () => 'Vertices (drawn)',
  'report.metric.verticesStored': () => 'Vertices (stored)',
  'report.metric.meshes': () => 'Meshes',
  'report.metric.materials': () => 'Materials',
  'report.metric.textures': () => 'Textures',
  'report.metric.nodes': () => 'Scene nodes',

  // --- geometry/compress ---
  'feature.meshopt': () => 'Meshopt',
  'feature.draco': () => 'Draco',
  'feature.resize4096': () => '4096 px',
  'feature.resize2048': () => '2048 px',
  'feature.resize1024': () => '1024 px',
  'feature.resize512': () => '512 px',
  'compress.safe': () => 'compression packs vertex data, polygon count does not change',
  'compress.done': ({ codec }) => `Geometry compressed (${codec}) — polygon count unchanged`,

  // --- geometry/quantize ---
  'quantize.safe': () => 'coordinates are written with fewer digits, polygon count does not change; the site needs nothing extra',
  'quantize.done': ({ pct }) => `Geometry quantized: the data is ${pct}% lighter — polygons untouched, no decoder needed on the site`,
  'quantize.done.scene': () => 'One quantization range for the whole scene — per-mesh ranges would have broken the skeleton binding apart',
  'quantize.skipped.already': () => 'Geometry is already quantized — a second pass would only add loss',
  'quantize.skipped.compressed': ({ codec }) => `Geometry is already packed (${codec}) — this method adds nothing on top of it`,

  // --- integrity checks (validate) ---
  'check.geometryEmpty': () => 'no triangle geometry before or after',
  'check.geometryPresent': () => 'geometry is present',
  'check.geometryBroken': () => 'GEOMETRY IS EMPTY — broken file!',
  'check.trianglesUnchanged': () => 'triangle count unchanged',
  'check.trianglesDropped': ({ n }) => `triangle count dropped by ${n} — only degenerate ones (zero area), render is identical`,
  'check.trianglesMismatch': ({ expected, got }) => `triangle mismatch: expected ${expected}, got ${got}`,
  'check.animationsPreserved': ({ n }) => `animations: ${n}`,
  'check.animationsLost': ({ before, after }) => `animations lost: was ${before}, now ${after}`,
  'check.skinsPreserved': ({ n }) => `effective skins: ${n}`,
  'check.skinsLost': ({ before, after }) => `skins lost: was ${before}, now ${after}`,
  'check.scenesPreserved': ({ n }) => `scene hierarchy intact: ${n}`,
  'check.scenesLost': ({ before, after }) => `scenes lost: was ${before}, now ${after}`,
  'check.boundsUnchanged': () => 'bounding box within epsilon',
  'check.boundsSkippedAfterInstance': () => 'bounding box check skipped after GPU instancing — getBounds() does not support EXT_mesh_gpu_instancing',
  'check.boundsSkinnedQuantized': () => 'bounding box check skipped: the model is skinned and geometry is quantized — the compensation lives in the skin matrices, which getBounds() does not read. Shape and topology are verified by the other checks',
  'check.boundsChanged': () => 'bounding box changed — model shifted or collapsed',
  'check.boundsNotComputed': () => 'bounding box not computed (getBounds unavailable or no scene)',
  'check.boundsNoGeometry': () => 'bounding box check skipped: the model has no geometry — there is nothing to measure',
  'check.materialsResolve': () => 'every material resolves',
  'check.materialsBroken': () => 'a primitive references a deleted material',
  'check.validatorZeroErrors': () => 'gltf-validator (Khronos): 0 errors',
  'check.validatorErrorsRemain': ({ errs, inErrs }) => `gltf-validator: ${errs} errors remain, inherited from the input (${inErrs} in the source) — optimization added none`,
  'check.validatorExample': ({ code, pointer }) => `example: ${code} @ ${pointer}`,
  'check.validatorErrorsIncreased': ({ errs, inErrs }) => `gltf-validator: ${errs} errors (input had ${inErrs}) — optimization added new ones`,
  'check.validatorSkipped': () => 'gltf-validator not installed — structural validation skipped',

  // --- rule titles ---
  'rule.structureDedup': () => 'Duplicate resources (dedup)',
  'rule.structurePruneUnused': () => 'Unused resources (prune)',
  'rule.attributesVertexColors': () => 'Vertex colors (COLOR_n)',
  'rule.skinJointsDedupe': () => 'Duplicate joint per vertex',
  'rule.skinWeightsNormalize': () => 'Skin weights normalization',
  'rule.skinZeroWeightJoints': () => 'Joints referenced with zero weight',
  'rule.sceneSkinnedMeshRoot': () => 'Skinned mesh outside the scene root',
  'rule.texturesResize': () => 'Texture downscale',
  'rule.geometryWeld': () => 'Vertex weld',
  'rule.geometryDegenerate': () => 'Degenerate triangles',
  'rule.geometryOrphan': () => 'Orphan vertices',
  'rule.sceneJoin': () => 'Mesh join (flatten + join)',
  'rule.sceneInstance': () => 'GPU instancing',
  'rule.animationResample': () => 'Resample animations',
  'rule.structurePruneFinal': () => 'Cleanup of orphaned resources',
  'rule.texturesKtx2': () => 'Textures → KTX2/UASTC',
  'rule.texturesWebp': () => 'Textures → WebP',
  'rule.geometryCompress': () => 'Geometry compression',
  'rule.geometryQuantize': () => 'Geometry quantization',
};
