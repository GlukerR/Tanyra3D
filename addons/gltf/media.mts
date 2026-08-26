// addons/gltf/media.mts — мелкие таблицы-константы формата, общие для разборщиков.
//
// ЗАВЕДЁН 2026-08-26 по находке Ф2-2/Ф2-3 аудита. Обе таблицы ниже лежали в трёх копиях
// каждая — в `import-fbx.mts`, `import-obj.mts`, `import-textures.mts` и `importers.mts`,
// побайтно одинаковые. Расхождение таких копий беззвучно: добавили формат в одном
// разборщике, забыли в соседнем, и картинка молча не доехала.
//
// Модуль-лист: не импортирует НИЧЕГО. Так он не может создать цикл ни с одним
// разборщиком, а разборщики зовут друг друга через `importers.mts`
// (сторож — tests/architecture/no-cycles.test.mjs).

/** Тип содержимого по расширению картинки. Ровно те форматы, что glTF кладёт в файл. */
export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

/** Тип аксессора glTF по числу чисел на элемент. Константа спецификации. */
export const TYPE_BY_SIZE: Record<number, string> = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/**
 * Назначение карты по имени файла: слот и признак имени.
 *
 * ОДНО объявление на весь проект. До 2026-08-26 таблица лежала ДВАЖДЫ — здесь (в
 * `import-textures.mts`) и побайтно такая же в `ui/app.ts`, — и это был не косметический
 * дубль. Движок по ней решает, КАКОЙ ФАЙЛ СТАНЕТ КАКОЙ КАРТОЙ; интерфейс по ней решает,
 * какую ранее бро́шенную карту ВЫБРОСИТЬ как заменённую (`attachTextures`, дефект
 * Александра 2026-08-22 про неменяющийся baseColor). Разойдись копии — интерфейс выкинул
 * бы файл, который движок посчитал картой другого назначения, и наоборот.
 *
 * Интерфейс получает эту таблицу через шов (`/api/extensions`, поле `textureSlots`), тем
 * же путём, каким уже получает группы взаимоисключений. Своей копии у него больше нет.
 *
 * ПОРЯДОК ВАЖЕН: `_AO` проверяется раньше прочего — две буквы легко найти внутри чужого
 * слова, и якоря по краям здесь обязательны.
 */
export const TEXTURE_SLOTS: Array<{ slot: string; re: RegExp }> = [
  { slot: 'baseColor', re: /(basecolor|base_color|albedo|diffuse|_col(our)?[._-]|_d\.)/i },
  { slot: 'normal', re: /(normal|_nrm[._-]|_n\.)/i },
  { slot: 'roughness', re: /(rough|_rgh[._-])/i },
  { slot: 'metallic', re: /(metal|_mtl[._-])/i },
  { slot: 'occlusion', re: /((^|[._-])ao([._-]|$)|occlusion|ambient)/i },
  { slot: 'emissive', re: /(emissi|_emit[._-])/i },
];

/**
 * Та же таблица в виде, который переживает JSON: регулярка распадается на текст и флаги.
 *
 * Отдельная функция, а не поле, потому что через HTTP `RegExp` не проходит — он
 * сериализуется в пустой объект `{}`. Собрать обратно на той стороне: `new RegExp(pattern, flags)`.
 */
export function textureSlotsWire(): Array<{ slot: string; pattern: string; flags: string }> {
  return TEXTURE_SLOTS.map(({ slot, re }) => ({ slot, pattern: re.source, flags: re.flags }));
}
