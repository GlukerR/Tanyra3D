const where = ({ sem, mesh }) => `${sem} (mesh "${mesh || '—'}")`;

export default {
  'dedup.safe': () => 'merging identical resources is structurally safe',
  'dedup.found.textures': ({ n }) => `duplicate textures: ${n}`,
  'dedup.found.materials': ({ n }) => `duplicate materials: ${n}`,
  'dedup.found.accessors': ({ n }) => `duplicate accessors: ${n}`,
  'dedup.done.textures': ({ n }) => `Merged duplicate textures (${n})`,
  'dedup.done.materials': ({ n }) => `Merged duplicate materials (${n})`,
  'dedup.done.accessors': ({ n }) => `Merged duplicate accessors (${n})`,

  'prune.safe': () => 'only resources with no remaining references are removed',
  'prune.found.attribute': ({ sem }) => `attribute ${sem} is not used by any material`,
  'prune.found.attributes': ({ n, list }) => `${n} attribute${n === 1 ? ' is' : 's are'} not used by any material (${list})`,
  'prune.found.textures': ({ n }) => `unused textures: ${n}`,
  'prune.found.materials': ({ n }) => `unused materials: ${n}`,
  'prune.found.emptySkins': ({ n }) => `empty skins (meshes have no JOINTS/WEIGHTS): ${n}`,
  'prune.done.attribute': ({ sem }) => `Attribute ${sem}: not used by any material — removed (prune)`,
  'prune.done.attributes': ({ n, list }) => `Removed ${n} unused attribute${n === 1 ? '' : 's'} (${list})`,
  'prune.done.textures': ({ n }) => `Textures: removed ${n} unused`,
  'prune.done.materials': ({ n }) => `Materials: removed ${n} unused`,
  'prune.done.emptySkins': ({ n }) => `Removed ${n} empty skin${n === 1 ? '' : 's'} — no deformation, animation runs through the node hierarchy`,

  'vertexColors.safe': () => 'white channels are removed provably safely; painted ones only via flag',
  'vertexColors.found.white': (d) => `${where(d)}: all values white — no visual effect`,
  'vertexColors.found.painted': (d) => `${where(d)}: real vertex painting`,
  'vertexColors.done.white': (d) => `${where(d)}: all values white — removed, look unchanged`,
  'vertexColors.stripped': (d) => `${where(d)}: PAINTED, removed via --strip-vertex-colors flag — look may change`,
  'vertexColors.skipped': (d) => `${where(d)}: real painting — NOT removed, affects the look. Force with: --strip-vertex-colors`,
  'vertexColors.found.white.many': ({ sem, n, list }) => `${sem}: all values white — no visual effect; ${n} meshes (${list})`,
  'vertexColors.found.painted.many': ({ sem, n, list }) => `${sem}: real vertex painting; ${n} meshes (${list})`,
  'vertexColors.done.white.many': ({ sem, n, list }) => `${sem}: all values white — removed, look unchanged; ${n} meshes (${list})`,
  'vertexColors.stripped.many': ({ sem, n, list }) => `${sem}: PAINTED, removed via --strip-vertex-colors flag — look may change; ${n} meshes (${list})`,
  'vertexColors.skipped.many': ({ sem, n, list }) => `${sem}: real painting — NOT removed, affects the look. Force with: --strip-vertex-colors; ${n} meshes (${list})`,

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

  'skinnedRoot.safe': () => 'the node is moved only when every transform above it is an identity one — the scene keeps every number it had',
  'skinnedRoot.found': ({ n }) => `skinned meshes sitting outside the scene root: ${n}`,
  'skinnedRoot.done': ({ n }) => `Moved ${n} skinned mesh${n === 1 ? '' : 'es'} to the scene root — the pose is unchanged, the viewer no longer warns`,
  'skinnedRoot.skipped.notProvable': ({ n }) => `${n} skinned mesh${n === 1 ? '' : 'es'} left where ${n === 1 ? 'it is' : 'they are'}: something above ${n === 1 ? 'it' : 'them'} moves or scales, and re-parenting would mean recomputing the pose`,

  'resize.safe': () => 'only textures larger than the chosen size are shrunk; proportions are kept',
  'resize.found': ({ n, px }) => `textures larger than ${px} px: ${n}`,
  'resize.done': ({ n, px, kb }) => `Shrunk ${n} texture${n === 1 ? '' : 's'} to ${px} px on the longer side (${kb} KB lighter). The discarded pixels are gone — keep the original elsewhere`,
  'resize.skipped.compressed': ({ n }) => `${n} texture${n === 1 ? ' was' : 's were'} left as ${n === 1 ? 'it is' : 'they are'} — already compressed for the video card (KTX2 and the like). Shrinking those means unpacking and repacking, losing quality twice: shrink first, compress after`,
  'resize.skipped.unreadable': ({ n }) => `${n} texture${n === 1 ? '' : 's'} skipped — the image size could not be read`,
  'resize.skipped.failed': ({ n }) => `${n} texture${n === 1 ? '' : 's'} not shrunk — the image could not be re-encoded`,

  'weld.safe': () => 'only identical vertices are welded',
  'weld.found': ({ n }) => `identical vertices: ${n}`,
  'weld.done': ({ before, after }) => `Vertex weld: ${before} → ${after}`,

  'slot.baseColor': () => 'colour',
  'slot.normal': () => 'surface relief',
  'slot.roughness': () => 'roughness',
  'slot.metallic': () => 'metal',
  'slot.occlusion': () => 'ambient shading',
  'slot.emissive': () => 'glow',
  'rule.importTexturesAttached': () => 'Maps found next to the model',
  'import.textureAttached': ({ slot, file }) => `${slot} ← ${file}`,
  'rule.importNotCarried': () => 'Not carried over from the source',
  'import.textureMissing': ({ name }) => `the file names texture "${name}", but it was not next to it — the material is without it`,
  'import.textureMissing.many': ({ n }) => `textures named in the file but not found next to it: ${n} — those materials are without them`,
  'import.animationsDropped': ({ n }) => (n === 1
    ? 'the source has an animation — it is not carried over yet'
    : `animations in the source: ${n} — they are not carried over yet`),
  'import.skinsDropped': ({ n }) => (n === 1
    ? 'the source has a skeleton — it is not carried over yet'
    : `skeletons in the source: ${n} — they are not carried over yet`),
  'degenerate.safe': () => 'a triangle with two corners in the same spot has zero area and is not drawn',
  'degenerate.found': ({ n }) => `degenerate triangles (zero area): ${n}`,
  'degenerate.done': ({ n }) => `Degenerate triangles: removed ${n} (zero area, had no render effect)`,

  'orphan.unavailable': () => 'compactPrimitive is unavailable in this @gltf-transform/functions version — pass skipped',
  'orphan.safe': () => 'vertices addressed by no index and not drawn',
  'orphan.found': ({ n }) => `orphan vertices: ${n}`,
  'orphan.done': ({ n }) => `Orphan vertices: removed ${n} (addressed by no index, not drawn)`,

  'unsupportedExtension.refuse': ({ list }) =>
    `the model uses ${list}, which this pipeline does not understand. Such an extension can address properties by index (KHR_animation_pointer does), so removing or renumbering anything would silently break it — structural changes are refused. Compression and texture options still work.`,

  'join.safe': () => 'model is static, separate parts not needed (otherwise --keep-parts)',
  'join.found': ({ drawCalls, nodes }) => `extra draw calls / nodes: draw calls ${drawCalls}, nodes ${nodes}`,
  'join.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Meshes joined (flatten+join): draw calls ${dcBefore} → ${dcAfter}, nodes ${nodesBefore} → ${nodesAfter}`,
  'join.keptShared': ({ meshes }) =>
    `Left alone: ${meshes} mesh(es) shared by several nodes. Joining them would bake the same geometry into a separate copy per node — the file would grow instead of shrinking. Turn on GPU instancing to cut their draw calls without the extra bytes.`,
  'interactivity.found': ({ clickable, handlers, actions }) =>
    `The file carries interactivity: ${clickable} clickable part${clickable === 1 ? '' : 's'}, ${handlers} handler${handlers === 1 ? '' : 's'}, ${actions} action${actions === 1 ? '' : 's'}. The clickable parts are outlined in the viewport — click one and the model responds. All of it survives the build.`,
  'interactivity.foundNoClicks': ({ handlers, actions }) =>
    `The file carries interactivity that runs on its own, with nothing to click: ${handlers} handler${handlers === 1 ? '' : 's'}, ${actions} action${actions === 1 ? '' : 's'}. All of it survives the build.`,
  'interactivity.silentParts': ({ n }) =>
    `${n} clickable part${n === 1 ? '' : 's'} with no handler. The author marked ${n === 1 ? 'it' : 'them'} clickable, but the graph says nothing about ${n === 1 ? 'it' : 'them'} — clicking changes nothing, here or on a site.`,
  'lod.likelyNames': ({ nodes, levels }) =>
    `The file looks like it carries levels of detail: ${nodes} part${nodes === 1 ? '' : 's'} with up to ${levels} levels each. Neighbouring nodes are named LOD, but nothing links them together — so here and on a site every level is drawn at once, one through another.`,
  'lod.likelyMeasured': ({ nodes, levels }) =>
    `The file looks like it carries levels of detail: ${nodes} part${nodes === 1 ? '' : 's'} with up to ${levels} levels each. Measured, not labelled: the same thing made several times coarser. Nothing links the levels together — so here and on a site every level is drawn at once, one through another.`,
  'lod.found': ({ nodes, levels }) =>
    `The file carries levels of detail: ${nodes} part${nodes === 1 ? '' : 's'} with up to ${levels} levels each. The preview shows the most detailed one; on a site the engine picks a simpler level when the object is small on screen.`,
  'morph.found.animated': ({ meshes, forms }) =>
    `The file carries alternative shapes: ${meshes} part${meshes === 1 ? '' : 's'} with up to ${forms} shape${forms === 1 ? '' : 's'} each. Animation drives them — press play to see it.`,
  'morph.found.still': ({ meshes, forms }) =>
    `The file carries alternative shapes: ${meshes} part${meshes === 1 ? '' : 's'} with up to ${forms} shape${forms === 1 ? '' : 's'} each. No animation drives them, so both here and on a site only the base shape shows.`,
  'join.keptVariants': ({ meshes }) =>
    `Left alone: ${meshes} mesh(es) that carry material variants — the alternative colours and finishes the model can switch between. Joining them would merge the parts the switch relies on, and the choice would silently stop working. The price is a few extra draw calls.`,

  'instance.found': () => 'repeated meshes — they can be drawn with one command instead of one per copy',
  'instance.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Repeats collected into instances: draw calls ${dcBefore} → ${dcAfter}, nodes ${nodesBefore} → ${nodesAfter}`,
  'instance.unbaked': ({ n, groups }) => (groups === 1
    ? `${n} identical copies recognised by shape — they arrived as separate meshes because the exporter baked the offset into the vertices`
    : `${n} identical copies recognised by shape (${groups} distinct shapes) — they arrived as separate meshes because the exporter baked the offset into the vertices`),
  'instance.skipped.nothing': () => 'no repeated meshes — nothing to collect into instances',
  'instance.skipped.animated': ({ n }) => (n === 1
    ? 'the one repeated mesh here is moved by an animation — batching would freeze it in place'
    : `${n} repeated meshes are moved by animation — batching would freeze them in place`),

  'prune.done.keptUv': () => 'UV was kept, including the parts no image uses right now',

  'interactivityStripDead.found': ({ n }) =>
    `${n} clickable part${n === 1 ? '' : 's'} with no handler. They can be clicked, but the model does not say what should happen.`,
  'interactivityStripDead.done': ({ n, left }) =>
    `Empty clickable marks removed: ${n}. ${left} working part${left === 1 ? '' : 's'} left — neither they nor the behaviour graph were touched.`,
  'interactivityStripDead.skipped.none': () => 'the model has no empty clickable marks — nothing to remove',

  'resample.done': ({ pct }) => `Redundant keyframes removed: animation data ${pct}% lighter — the motion is unchanged`,
  'resample.skipped.noAnimations': () => 'the model has no animations',
  'resample.skipped.minimal': () => 'no redundant keyframes — the animation is already minimal',

  'ktx2.grewFile': ({ beforeKb, afterKb, pct }) =>
    `KTX2 made the textures heavier: ${beforeKb} KB → ${afterKb} KB (+${pct}%). `
    + `PNG and JPEG are compressed for transfer and unpacked before they reach the GPU; KTX2 stays compressed in video memory. `
    + `On a large texture it wins on both — on a small one the container overhead outweighs the picture itself. `
    + `Video memory still went down, so keep KTX2 only if that is what you are optimising for.`,

  'pruneFinal.safe': () => 'only resources orphaned by previous fixes are removed',
  'pruneFinal.done': ({ n }) => `Cleanup (prune): removed ${n} orphaned accessor${n === 1 ? '' : 's'}`,

  'ktx2.noTools': () => 'toktx or gltf-transform CLI not found — textures left in their original format',
  'ktx2.safe': () => 'UASTC --level 2 --zstd 18 without RDO — near-lossless, user\'s choice',
  'ktx2.skipped.already': ({ name }) => `Texture "${name}": already KTX2 — not re-encoded (no extra loss)`,
  'ktx2.skipped.already.many': ({ n }) => `${n} textures are already KTX2 — not re-encoded (no extra loss)`,
  'ktx2.skipped.toPngFailed': ({ n }) => `${n} texture${n === 1 ? '' : 's'} could not be converted to PNG — left in the original format`,
  'ktx2.done.toPng': ({ n, from }) => `${n} texture${n === 1 ? '' : 's'} converted ${from} → PNG (lossless, required by toktx)`,
  'ktx2.found': ({ n }) => `${n} incoming texture${n === 1 ? ' was' : 's were'} not KTX2 — these are the ones being encoded`,
  'ktx2.done.color': ({ n, list }) => `${n} color texture${n === 1 ? '' : 's'} → KTX2/ETC1S, quality 255${list ? ` (${list})` : ''} — compact in file and in VRAM`,
  'ktx2.done.data': ({ n, list }) => `${n} data texture${n === 1 ? '' : 's'} → KTX2/UASTC --level 2 --zstd 18${list ? ` (${list})` : ''} — normals/ORM without ETC1S artifacts`,
  'ktx2.done.uastc': ({ n }) => `Textures → KTX2/UASTC: ${n} (--level 2 --zstd 18, no RDO; --uastc mode)`,
  'ktx2.relabeled': ({ n, list }) => `${n} data texture${n === 1 ? '' : 's'} relabeled to linear (${list}) — the encoder marked them sRGB, which darkens occlusion/roughness at render time`,
  'ktx2.log.skipped': () => '        all textures are already KTX2 or absent — encoding skipped',
  'ktx2.log.encoding': ({ n, mixed }) => `        KTX2 encoding (${n}, mode ${mixed ? 'mixed: ETC1S+UASTC' : 'uastc'})`,

  'ktx2.invalid': () => 'the texture file cannot be read',
  'ktx2.hdr': () => 'a high dynamic range texture — we do not convert those',
  'ktx2.multiface': () => 'a cube or layered texture — we do not convert those',
  'ktx2.transcodeStart': () => 'the unpacker could not start',
  'ktx2.transcodeFailed': () => 'unpacking failed',
  'ktx2.decodeFailed': () => 'could not be unpacked',

  'flat.safe': () => 'the colour is kept byte for byte; only the resolution changes, and in a single-colour fill it means nothing',
  'flat.skipped.failed': ({ n }) => `${n} texture${n === 1 ? '' : 's'} not checked for a flat fill — the image could not be read`,
  'flat.found': ({ n }) => `${n} texture${n === 1 ? ' is' : 's are'} filled with a single colour`,
  'flat.done': ({ n, vramMb }) => `${n} single-colour texture${n === 1 ? '' : 's'} shrunk to one pixel — ${vramMb} MB less video memory, same colour${n === 1 ? '' : 's'}`,

  'webp.safe': () => 'quality is taken from the source itself: whatever arrived lossless is encoded lossless, and whatever arrived compressed keeps its own quality — no higher, no lower; every texture in the model is encoded',
  'webp.skipped.failed': ({ name, reason }) => `Texture "${name}" could not be encoded (${reason}) — left as it was, the build was not interrupted`,
  'webp.found': ({ n }) => `${n} texture${n === 1 ? ' — it is' : 's — all of them are'} being encoded`,
  'webp.done.color': ({ n }) => `${n} color texture${n === 1 ? '' : 's'} → WebP — smaller file, video memory unchanged`,
  'webp.done.data': ({ n }) => `${n} data texture${n === 1 ? '' : 's'} → WebP lossless — normals and roughness are numbers, lossy chroma would distort them`,
  'webp.done.dataLossy': ({ n }) => `${n} data texture${n === 1 ? ' arrived' : 's arrived'} already lossily compressed — encoded the same way, with chroma subsampling off: lossless would make ${n === 1 ? 'it' : 'them'} several times heavier without recovering a single lost value`,
  'webp.done.dataByChoice': ({ n, share }) => `${n} data texture${n === 1 ? ' arrived' : 's arrived'} lossless but ${n === 1 ? 'was' : 'were'} encoded lossily — the quality slider is at ${share}%: normals and roughness are numbers, and they got coarser`,
  'webp.done.fromGpu': ({ n }) => `${n} texture${n === 1 ? '' : 's'} unpacked from a GPU format and converted to WebP — quality lost twice (that format is lossy too), the mip pyramid is gone and will be rebuilt by the engine, video memory will grow`,
  'webp.alreadyTarget': ({ n }) => `${n} texture${n === 1 ? ' is' : 's are'} already WebP — nothing to convert, the goal is already met`,
  'webp.sourceQuality': ({ q }) => `Source texture quality: about ${q} — encoded at the same level, there is no going above the source`,
  'webp.sourceQuality.range': ({ min, max }) => `Source texture quality: about ${min} to ${max} — each encoded at its own level, there is no going above the source`,
  'webp.ceilingUnknown': ({ n, q }) => `${n} texture${n === 1 ? ' gives' : 's give'} no way to tell the source quality — ${q} was used`,
  'webp.quality': ({ share }) => `Quality: ${share}% of the source`,
  'webp.grewFile': ({ beforeKb, afterKb, pct }) => `Images got heavier because of this option: ${beforeKb} KB → ${afterKb} KB (+${pct}%)`,
  'webp.grewVram': ({ beforeMb, afterMb, pct }) => `Video memory grew because of this option: ${beforeMb} MB → ${afterMb} MB (+${pct}%). The file may well have shrunk at the same time: WebP wins on download size and loses on GPU memory`,

  'prune.refuse.wouldEmptyScene': ({ n }) => `the model has ${n} node${n === 1 ? '' : 's'} and no shapes at all — cleanup would take the whole scene away, so it is left alone`,

  'reversal.join': () => 'Node hierarchy and separate parts are merged — they cannot be restored from the result. To keep parts, leave joining off.',
  'reversal.instance': () => 'Instancing can be expanded back to individual nodes.',
  'reversal.ktx2': () => 'KTX2 can be unpacked back to PNG/WebP with a small quality loss.',
  'reversal.webp': () => 'WebP can be decoded back to PNG, but lossy re-encoding is not undone.',
  'reversal.compress': () => 'Compressed geometry unpacks back to the standard format without data loss.',
  'reversal.quantize': () => 'Quantized geometry unpacks back to float32, but the precision dropped in quantization does not come back.',

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

  'feature.meshopt': () => 'Meshopt',
  'feature.draco': () => 'Draco',
  'feature.resize4096': () => '4096 px',
  'feature.resize2048': () => '2048 px',
  'feature.resize1024': () => '1024 px',
  'feature.resize512': () => '512 px',
  'compress.safe': () => 'compression packs vertex data, polygon count does not change',
  'compress.done': ({ codec }) => `Geometry compressed (${codec}) — polygon count unchanged`,

  'quantize.safe': () => 'coordinates are written with fewer digits, polygon count does not change; the site needs nothing extra',
  'quantize.done': ({ pct }) => `Geometry quantized: the data is ${pct}% lighter — polygons untouched, no decoder needed on the site`,
  'quantize.done.scene': () => 'One quantization range for the whole scene — per-mesh ranges would have broken the skeleton binding apart',
  'quantize.skipped.already': () => 'Geometry is already quantized — a second pass would only add loss',
  'quantize.skipped.compressed': ({ codec }) => `Geometry is already packed (${codec}) — this method adds nothing on top of it`,

  'io.pointCloud': ({ format }) => `This ${format} has no faces — only points. A point cloud is not a model this program can work with.`,
  'io.noGeometry': ({ format }) => `This ${format} has no geometry: not a single vertex.`,
  'io.unreadable': ({ format }) => `This ${format} could not be read: the file looks truncated or damaged.`,
  'io.missingResources': ({ names }) => `Missing files this .gltf refers to: ${names}. Drop the whole folder, not just the .gltf.`,

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

  'rule.structureDedup': () => 'Duplicate resources (dedup)',
  'rule.structurePruneUnused': () => 'Unused resources (prune)',
  'rule.attributesVertexColors': () => 'Vertex colors (COLOR_n)',
  'rule.skinJointsDedupe': () => 'Duplicate joint per vertex',
  'rule.skinWeightsNormalize': () => 'Skin weights normalization',
  'rule.skinZeroWeightJoints': () => 'Joints referenced with zero weight',
  'rule.sceneSkinnedMeshRoot': () => 'Skinned mesh outside the scene root',
  'rule.texturesFlat': () => 'Single-colour textures',
  'rule.texturesResize': () => 'Texture downscale',
  'rule.geometryWeld': () => 'Vertex weld',
  'rule.geometryDegenerate': () => 'Degenerate triangles',
  'rule.geometryOrphan': () => 'Orphan vertices',
  'rule.sceneJoin': () => 'Mesh join (flatten + join)',
  'rule.sceneInteractivity': () => 'Interactivity',
  'rule.sceneLodLevels': () => 'Levels of detail',
  'rule.sceneMorphTargets': () => 'Alternative shapes',
  'rule.sceneInstance': () => 'GPU instancing',
  'rule.interactivityStripDead': () => 'Empty clickable marks',
  'rule.animationResample': () => 'Resample animations',
  'rule.structurePruneFinal': () => 'Cleanup of orphaned resources',
  'rule.texturesKtx2': () => 'Textures → KTX2/UASTC',
  'rule.texturesWebp': () => 'Textures → WebP',
  'rule.geometryCompress': () => 'Geometry compression',
  'rule.geometryQuantize': () => 'Geometry quantization',
};
