# Лицензия: PotOfCoalsAnimationPointer.glb

> Sidecar-файл лицензии модели golden-корпуса. Часть полей извлечена автоматически из
> встроенных метаданных glTF (`fixtures/check-licenses.mjs`), остальные заполнены вручную.
> Проверено: 2026-07-27, дополнено по первоисточнику 2026-08-14.

- **Файл модели:** PotOfCoalsAnimationPointer.glb
- **Название (title):** Pot of Coals Animation Pointer
- **Автор:** Eric Chadwick (модель и текстуры)
- **Лицензия:** CC BY 4.0 International
- **Copyright (asset.copyright):** Asset © 2024 Darmstadt Graphics Group GmbH, CC BY 4.0 International, created by Eric Chadwick. Khronos logo © 2015, Khronos Group. glTF logo © 2017, Khronos Group. DGG logo © 2020, Darmstadt Graphics Group GmbH.
- **Источник / URL:** https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/PotOfCoalsAnimationPointer
- **Generator:** HS glTF exporter for 3dsmax 1.47c (custom3dsmax@gmail.com)

## Условия использования

- **Можно ли распространять (redistributable)?** да
- **Требуется атрибуция?** да (CC BY 4.0)
- **Ссылка на страницу модели/лицензии:** https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/PotOfCoalsAnimationPointer/README.md

## Что это за модель

Обгоревший медный котелок под лаком, внутри светящиеся угли, над ними — дрожание
воздуха от жара.

Само дрожание и сделано указателем анимации: два слоя текстур вращаются в РАЗНЫЕ
стороны — карта толщины объёма против часовой, карта нормалей по часовой. От их
наложения получается рябь, похожая на настоящее марево, а не на крутящуюся картинку.

## Почему в нашем вьюпорте не видно ничего

Оба канала анимируют развёртку тех слотов, у которых в three.js собственного
преобразования нет вовсе: карта нормалей и карта толщины объёма делят развёртку с
основной картой. Своё смещение и поворот есть только у `.map` и карты свечения.

Поэтому здесь не «часть анимации», а ноль: обоим каналам не к чему привязаться. Это
предел движка, а не наша поломка и не дефект плагина — см. `docs/ЗАВИСИМОСТИ.md`,
карточку `@needle-tools/three-animation-pointer`.

Где посмотреть, как задумано (оба движка читают расширение сами):

- Эталонный просмотрщик Khronos — https://github.khronos.org/glTF-Sample-Viewer-Release/
- Песочница Babylon.js — https://sandbox.babylonjs.com/
