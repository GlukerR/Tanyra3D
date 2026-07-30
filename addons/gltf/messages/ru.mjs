// addons/gltf/messages/ru.mjs — русский каталог сообщений правил glTF-аддона.
// Ключи те же, что в en.mjs; правила не переписываются (docs/EXTENDING.md §5).
//
// glTF-аддон входит в постоянную поставку, поэтому переведён. Сторонний аддон может
// ограничиться английским — core/i18n.mjs откатится на него (см. ui/locales/README.md).
//
// Тон — по docs/СЛОВАРЬ_формулировок.md: «отрисовки за кадр» вместо draw calls,
// «совпадающие вершины» вместо weld. Термин остаётся там, где он и есть название
// технологии (KTX2, UASTC, ETC1S) — переводить их значит запутать.

const where = ({ sem, mesh }) => `${sem} (меш «${mesh || '—'}»)`;

export default {
  // --- structure/dedup ---
  'dedup.safe': () => 'объединение одинаковых ресурсов структурно безопасно',
  'dedup.found.textures': ({ n }) => `повторяющихся текстур: ${n}`,
  'dedup.found.materials': ({ n }) => `повторяющихся материалов: ${n}`,
  'dedup.found.accessors': ({ n }) => `повторяющихся блоков данных: ${n}`,
  'dedup.done.textures': ({ n }) => `Одинаковые текстуры объединены (${n})`,
  'dedup.done.materials': ({ n }) => `Одинаковые материалы объединены (${n})`,
  'dedup.done.accessors': ({ n }) => `Одинаковые блоки данных объединены (${n})`,

  // --- structure/prune-unused ---
  'prune.safe': () => 'удаляются только ресурсы, на которые не осталось ссылок',
  'prune.found.attribute': ({ sem }) => `атрибут ${sem} не используется ни одним материалом`,
  'prune.found.textures': ({ n }) => `неиспользуемых текстур: ${n}`,
  'prune.found.materials': ({ n }) => `неиспользуемых материалов: ${n}`,
  'prune.found.emptySkins': ({ n }) => `пустых скинов (у мешей нет JOINTS/WEIGHTS): ${n}`,
  'prune.done.attribute': ({ sem }) => `Атрибут ${sem}: не используется ни одним материалом — удалён`,
  'prune.done.textures': ({ n }) => `Текстуры: удалено неиспользуемых — ${n}`,
  'prune.done.materials': ({ n }) => `Материалы: удалено неиспользуемых — ${n}`,
  'prune.done.emptySkins': ({ n }) => `Удалено пустых скинов: ${n} — деформации нет, анимация идёт через иерархию узлов`,

  // --- attributes/vertex-colors ---
  'vertexColors.safe': () => 'белые каналы удаляются доказуемо безопасно, раскрашенные — только по флагу',
  'vertexColors.found.white': (d) => `${where(d)}: все значения белые — на картинку не влияют`,
  'vertexColors.found.painted': (d) => `${where(d)}: настоящая раскраска вершин`,
  'vertexColors.done.white': (d) => `${where(d)}: все значения белые — удалены, вид не изменился`,
  'vertexColors.stripped': (d) => `${where(d)}: РАСКРАШЕННЫЕ, удалены по флагу --strip-vertex-colors — вид может измениться`,
  'vertexColors.skipped': (d) => `${where(d)}: настоящая раскраска — НЕ удалена, влияет на вид. Принудительно: --strip-vertex-colors`,

  // --- geometry/weld ---
  'weld.safe': () => 'склеиваются только полностью совпадающие вершины',
  'weld.found': ({ n }) => `совпадающих вершин: ${n}`,
  'weld.done': ({ before, after }) => `Совпадающие вершины склеены: ${before} → ${after}`,

  // --- geometry/degenerate-triangles ---
  'degenerate.safe': () => 'треугольник с повторяющимся индексом имеет нулевую площадь и не рисуется',
  'degenerate.found': ({ n }) => `вырожденных треугольников (нулевая площадь): ${n}`,
  'degenerate.done': ({ n }) => `Вырожденные треугольники: удалено ${n} (нулевая площадь, на картинку не влияли)`,

  // --- geometry/orphan-vertices ---
  'orphan.unavailable': () => 'compactPrimitive недоступен в этой версии @gltf-transform/functions — проход пропущен',
  'orphan.safe': () => 'вершины, на которые не ссылается ни один индекс и которые не рисуются',
  'orphan.found': ({ n }) => `висящих в пустоте вершин: ${n}`,
  'orphan.done': ({ n }) => `Висящие вершины: удалено ${n} (ни один индекс на них не ссылается, не рисовались)`,

  // --- scene/join ---
  'join.safe': () => 'модель статичная, отдельные части не нужны (иначе --keep-parts)',
  'join.found': ({ drawCalls, nodes }) => `лишние отрисовки и узлы: отрисовок за кадр ${drawCalls}, узлов ${nodes}`,
  'join.done': ({ dcBefore, dcAfter, nodesBefore, nodesAfter }) =>
    `Меши объединены: отрисовок за кадр ${dcBefore} → ${dcAfter}, узлов ${nodesBefore} → ${nodesAfter}`,

  // --- structure/prune-final ---
  'pruneFinal.safe': () => 'удаляются только ресурсы, осиротевшие после предыдущих правок',
  'pruneFinal.done': ({ n }) => `Финальная чистка: удалено осиротевших блоков данных — ${n}`,

  // --- textures/ktx2 ---
  'ktx2.noTools': () => 'toktx или gltf-transform CLI не найдены — текстуры остались в исходном формате',
  'ktx2.safe': () => 'UASTC --level 2 --zstd 18 без RDO — почти без потерь, по выбору пользователя',
  'ktx2.skipped.already': ({ name }) => `Текстура «${name}»: уже KTX2 — перекодировать не стали (лишних потерь нет)`,
  'ktx2.done.toPng': ({ n, from }) => `Текстур переведено ${from} → PNG: ${n} (без потерь, этого требует toktx)`,
  'ktx2.found': ({ n }) => `на входе было не в формате KTX2: ${n} ${n === 1 ? 'текстура' : 'текстур'} — они и кодируются`,
  'ktx2.done.color': ({ n, list }) => `Цветных текстур → KTX2/ETC1S, качество 255: ${n}${list ? ` (${list})` : ''} — компактно и в файле, и в видеопамяти`,
  'ktx2.done.data': ({ n, list }) => `Текстур с данными → KTX2/UASTC --level 2 --zstd 18: ${n}${list ? ` (${list})` : ''} — нормали и ORM без артефактов ETC1S`,
  'ktx2.done.uastc': ({ n }) => `Текстуры → KTX2/UASTC: ${n} (--level 2 --zstd 18, без RDO; режим --uastc)`,
  'ktx2.relabeled': ({ n, list }) => `Текстур с данными помечено линейными: ${n} (${list}) — кодировщик записал их как sRGB, из-за чего затенение и шероховатость темнели при отрисовке`,
  'ktx2.log.skipped': () => '        все текстуры уже KTX2 либо их нет — кодирование пропущено',
  'ktx2.log.encoding': ({ n, mixed }) => `        кодирование KTX2 (${n}, режим ${mixed ? 'смешанный: ETC1S+UASTC' : 'uastc'})`,

  // --- geometry/compress ---
  'compress.safe': () => 'сжатие упаковывает данные вершин, количество полигонов не меняется',
  'compress.done': ({ codec }) => `Геометрия сжата (${codec}) — количество полигонов не изменилось`,

  // --- integrity checks (validate) ---
  'check.geometryEmpty': () => 'до и после оптимизации треугольной геометрии нет',
  'check.geometryPresent': () => 'геометрия есть',
  'check.geometryBroken': () => 'ГЕОМЕТРИИ НЕТ — файл повреждён!',
  'check.trianglesUnchanged': () => 'количество треугольников не изменилось',
  'check.trianglesDropped': ({ n }) => `количество треугольников уменьшилось на ${n} — только вырожденные (нулевая площадь), картинка не меняется`,
  'check.trianglesMismatch': ({ expected, got }) => `несовпадение треугольников: ожидалось ${expected}, получено ${got}`,
  'check.animationsPreserved': ({ n }) => `анимации: ${n}`,
  'check.animationsLost': ({ before, after }) => `анимации потеряны: было ${before}, стало ${after}`,
  'check.skinsPreserved': ({ n }) => `действующих скинов: ${n}`,
  'check.skinsLost': ({ before, after }) => `скины потеряны: было ${before}, стало ${after}`,
  'check.scenesPreserved': ({ n }) => `иерархия сцен цела: ${n}`,
  'check.scenesLost': ({ before, after }) => `сцены потеряны: было ${before}, стало ${after}`,
  'check.boundsUnchanged': () => 'bounding box в пределах допуска',
  'check.boundsSkippedAfterInstance': () => 'проверка bounding box пропущена после GPU-инстансинга — getBounds() не поддерживает EXT_mesh_gpu_instancing',
  'check.boundsSkinnedQuantized': () => 'проверка bounding box пропущена: модель скинованная и геометрия квантована — компенсация лежит в матрицах скина, а getBounds() их не читает. Форму и топологию подтверждают остальные проверки',
  'check.boundsChanged': () => 'bounding box изменился — модель смещена или разрушена',
  'check.boundsNotComputed': () => 'bounding box не вычислен (getBounds недоступна или нет сцены)',
  'check.materialsResolve': () => 'все материалы разрешаются',
  'check.materialsBroken': () => 'примитив ссылается на удалённый материал',
  'check.validatorZeroErrors': () => 'gltf-validator (Khronos): 0 ошибок',
  'check.validatorErrorsRemain': ({ errs, inErrs }) => `gltf-validator: ${errs} ошибок осталось, унаследованы от входа (${inErrs} в исходнике) — оптимизация новых не добавила`,
  'check.validatorExample': ({ code, pointer }) => `пример: ${code} @ ${pointer}`,
  'check.validatorErrorsIncreased': ({ errs, inErrs }) => `gltf-validator: ${errs} ошибок (во входе было ${inErrs}) — оптимизация добавила новые`,
  'check.validatorSkipped': () => 'gltf-validator не установлен — структурная валидация пропущена',

  // --- rule titles ---
  'rule.structureDedup': () => 'Повторяющиеся ресурсы (dedup)',
  'rule.structurePruneUnused': () => 'Неиспользуемые ресурсы (prune)',
  'rule.attributesVertexColors': () => 'Цвета вершин (COLOR_n)',
  'rule.geometryWeld': () => 'Склейка вершин',
  'rule.geometryDegenerate': () => 'Вырожденные треугольники',
  'rule.geometryOrphan': () => 'Висящие вершины',
  'rule.sceneJoin': () => 'Объединение мешей (flatten + join)',
  'rule.sceneInstance': () => 'GPU-инстансинг',
  'rule.animationResample': () => 'Передискретизация анимаций',
  'rule.structurePruneFinal': () => 'Чистка осиротевших ресурсов',
  'rule.texturesKtx2': () => 'Текстуры → KTX2/UASTC',
  'rule.geometryCompress': () => 'Сжатие геометрии',
};
