// ui/viewer/vendor.d.ts — типы для плагинов загрузчика, которые их не везут.
//
// `three-gltf-extensions` (takahirox) — обычный JS без деклараций. Пакет живёт с 2021
// года и типов не обещал; ждать их — значит не поставить плагин вовсе.
//
// Объявление УЗКОЕ намеренно: описано ровно то, чем мы пользуемся, и в тех терминах,
// в каких оно приходит. Широкое `declare module 'three-gltf-extensions/*'` со значением
// `any` погасило бы ошибку компилятора, но и все будущие тоже — включая настоящие
// опечатки в именах путей.
//
// Что плагин делает (проверено по исходнику, loaders/KHR_materials_variants):
//   • в `afterRoot` кладёт имена вариантов в `gltf.userData.variants`;
//   • туда же вешает `gltf.functions.selectVariant(object, name|null, doTraverse?)`.
// Обе величины принадлежат КОНКРЕТНОЙ загрузке — переключатель замкнут на её parser.
// Как мы их снимаем при смене модели — см. `_disposeModel` в viewer.ts.

declare module 'three-gltf-extensions/loaders/KHR_materials_variants/KHR_materials_variants.js' {
  import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

  export default class GLTFMaterialsVariantsExtension {
    constructor(parser: GLTFParser);
    readonly name: string;
    /** Вызывается загрузчиком; возвращает null, когда расширения в файле нет. */
    afterRoot(gltf: unknown): null | Promise<void>;
  }
}
