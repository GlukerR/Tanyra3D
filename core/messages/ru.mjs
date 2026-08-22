// core/messages/ru.mjs — русский каталог сообщений ядра.
// Ключи те же, что в en.mjs; движок откатывается на английский при нехватке ключа.
// Зарегистрирован в core/engine.mjs.

export default {
  // --- baseline-checkpoint ---
  'metric.triangles': () => 'треугольники',
  'metric.vertices': () => 'вершины',
  'metric.drawCalls': () => 'вызовы отрисовки',
  'metric.skins': () => 'скелеты',
  'metric.nodes': () => 'узлы сцены',
  'metric.animations': () => 'анимации',
  'metric.morphTargets': () => 'морф-цели',
  'metric.attributes': () => 'атрибуты вершин',
  'check.baselineMatch': () => 'структура модели не изменилась при сжатии',
  'check.baselineSoftMismatch': ({ k, baseline, after }) =>
    `${k} пересобраны кодеком: ${baseline} → ${after}. Треугольники и картинка те же.`,
  // Отчёт называет ЧТО случилось и ЧТО делать. Разбор («согласно официальной
  // документации компонентов…», «ошибка библиотеки или некорректное использование»)
  // ушёл в журнал 2026-08-22: в правой панели он только пугал, а помочь человеку не мог.
  'check.baselineHardMismatch': ({ k, baseline, after }) =>
    `${k} изменились после сжатия: ${baseline} → ${after}. Так быть не должно — посмотрите модель глазами, прежде чем выкладывать. Подробности в журнале.`,

  // --- engine-level messages ---
  'feature.notEnabled': ({ feature }) => `возможность "${feature}" не включена (advancedFeatures: ['${feature}'])`,
  // Включённая возможность отработала, но менять было нечего. Молчать в этом
  // случае нельзя: человек поставил галочку и обязан узнать, что с ней стало.
  'engine.nothingToDo': () => 'включено, но в этой модели менять было нечего',
  'engine.feature.exclusive': ({ selected }) => `не применено: вместо этого выбран вариант «${selected}»`,
  'engine.outDirGone': () => 'рабочую папку очистили, пока шла сборка, — записывать стало некуда. Соберите заново.',
  'engine.skipped.line': ({ title, reason }) => `${title} — ${reason}`,

  // --- input compression ---
  'engine.inputCompression.found': ({ codecs }) => `входная геометрия уже сжата (${codecs}) — распакована при загрузке`,
  'engine.inputCompression.reencode': ({ codec }) => `перекодировано с нуля (${codec}), без двойного сжатия или скрытой переупаковки`,
  'engine.inputCompression.noCompress': () => 'геометрия экспортирована без сжатия (опция сжатия не выбрана)',
  'engine.inputCompression.applied': ({ codecs, note }) => `Входное сжатие снято: ${codecs} — ${note}`,

  // --- input validation ---
  // Число — часть языка: «уже 1 ошибок» — ошибка согласования на видном месте.
  'engine.inputValidation.found': ({ n }) => (n === 1
    ? 'во входном файле уже есть ошибка gltf-validator (дефект экспорта, а не оптимизации)'
    : `во входном файле уже ${n} ошибок gltf-validator (дефект экспорта, а не оптимизации)`),

  // --- policy ---
  'engine.policy.safetyLevel': ({ tier }) => `уровень безопасности "${tier}" не применяется автоматически`,
  'engine.policy.unknownSafetyLevel': ({ tier }) => `движок не знает уровня безопасности "${tier}" — правило пропущено`,
};
