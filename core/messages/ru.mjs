// core/messages/ru.mjs — русский каталог сообщений ядра.
// Ключи те же, что в en.mjs; движок откатывается на английский при нехватке ключа.
// Зарегистрирован в core/engine.mjs.

export default {
  // --- baseline-checkpoint ---
  'check.baselineMatch': ({ keys }) => `baseline-checkpoint: структура (${keys}) совпадает со снимком после базовых оптимизаций`,
  'check.baselineSoftMismatch': ({ k, baseline, after }) =>
    `${k} изменился при кодировании (было ${baseline} на точке отсчёта, стало ${after}) — `
    + 'кодек переиндексировал/склеил вершины (напр. Draco вызывает weld перед сжатием). '
    + 'Треугольники и топология мешей сохранены; запись не блокируется. Для анимированных моделей строгие ключи (скины, анимации) защищают структуру.',
  'check.cause.secondPass': ({ ids }) => `расширения второго прохода (${ids}) или сама запись файла`,
  'check.cause.writeOnly': () => 'запись файла (правок второго прохода не применялось)',
  'check.baselineHardMismatch': ({ k, baseline, after, cause }) =>
    `Нарушение гарантии компонента: ${k} изменился после расширений (было ${baseline} на точке отсчёта, стало ${after}). `
    + 'Согласно официальной документации компонентов (ARCHITECTURE.md §0a) Draco/Meshopt/KTX2 не меняют структуру мешей. '
    + `Вероятная причина: ${cause} — ошибка библиотеки или некорректное использование компонента. `
    + 'Файл записан, но доверять ему как точной копии исходной геометрии нельзя — сверьте результат глазами, прежде чем выкладывать.',

  // --- engine-level messages ---
  'feature.notEnabled': ({ feature }) => `возможность "${feature}" не включена (advancedFeatures: ['${feature}'])`,
  'engine.skipped.line': ({ title, reason }) => `${title} — ${reason}`,

  // --- input compression ---
  'engine.inputCompression.found': ({ codecs }) => `входная геометрия уже сжата (${codecs}) — распакована при загрузке`,
  'engine.inputCompression.reencode': ({ codec }) => `перекодировано с нуля (${codec}), без двойного сжатия или скрытой переупаковки`,
  'engine.inputCompression.noCompress': () => 'геометрия экспортирована без сжатия (опция сжатия не выбрана)',
  'engine.inputCompression.applied': ({ codecs, note }) => `Входное сжатие снято: ${codecs} — ${note}`,

  // --- input validation ---
  'engine.inputValidation.found': ({ n }) => `во входном файле уже ${n} ошибок gltf-validator (дефект экспорта, а не оптимизации)`,

  // --- policy ---
  'engine.policy.safetyLevel': ({ tier }) => `уровень безопасности "${tier}" не применяется автоматически`,
};
