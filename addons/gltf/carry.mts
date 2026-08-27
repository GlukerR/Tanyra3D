// addons/gltf/carry.mts — куда смотрит незнакомое расширение.
//
// Модуль-ЛИСТ: не импортирует ничего. Так он не создаёт цикла ни с `index.mts` (который
// переносит расширения через сборку), ни с `rules.mts` (который решает, отказываться ли
// правилу). До 2026-08-27 знание жило только в `index.mts`, а `rules.mts` о нём не знал —
// и потому мог только отказаться ВСЕМ незнакомым расширениям сразу либо никому.
//
// ЗАЧЕМ РАЗЛИЧАТЬ. Расширение, называющее цель СТРОКОЙ-АДРЕСОМ, безопасно для правил,
// которые этих массивов не касаются: `KHR_animation_pointer` на `AnimationPointerUVs`
// имеет 103 адреса, и все до единого смотрят в `materials`, — сварка вершин ему ничем не
// мешает. Расширение, хранящее ссылки числами (`MSFT_lod` перечисляет узлы,
// `KHR_interactivity` хранит граф), непрозрачно: на что оно смотрит, снаружи не видно,
// и любой сдвиг любого массива может его сломать.

/** Первый сегмент JSON-адреса вида `/materials/0/...` — имя массива, в который смотрят. */
const POINTER_RE = /^\/([A-Za-z_][A-Za-z_0-9]*)\/\d/;

/**
 * На какие массивы документа смотрит расширение — по его собственному тексту.
 *
 * @returns множество имён массивов, либо `null` — «непрозрачно, сузить не на чем».
 *   `null` вызывающий обязан читать как «сверяй всё» либо «откажись»: гадать нельзя.
 */
export function arraysAddressedBy(value: unknown): Set<string> | null {
  const names = new Set<string>();
  let sawString = false;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('/')) {
        sawString = true;
        const m = POINTER_RE.exec(v);
        if (m && m[1]) names.add(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return sawString && names.size ? names : null;
}

/**
 * Непрозрачно ли ХОТЯ БЫ ОДНО из названных расширений в этом документе.
 *
 * Обходит документ целиком: расширение живёт не только в корне — `MSFT_lod` висит на
 * узлах, `KHR_animation_pointer` на каналах анимации. Проверять один корень значит не
 * найти два из трёх (проверено пробой 2026-08-27).
 *
 * Расширение, ОБЪЯВЛЕННОЕ в `extensionsUsed`, но не имеющее тела нигде, непрозрачным НЕ
 * считается: ломать в нём нечего. Такой случай реален — заготовка
 * `Unknown Ext Pointer 01` объявляет `KHR_animation_pointer`, не имея ни одной анимации.
 */
export function hasOpaqueExtension(json: unknown, names: readonly string[]): string[] {
  if (!names.length) return [];
  const искомые = new Set(names);
  const непрозрачные = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'extensions' && val && typeof val === 'object') {
        for (const [имя, тело] of Object.entries(val as Record<string, unknown>)) {
          if (искомые.has(имя) && arraysAddressedBy(тело) === null) непрозрачные.add(имя);
        }
      }
      walk(val);
    }
  };
  walk(json);
  return [...непрозрачные].sort();
}
