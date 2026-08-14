# Лицензия: AnimationPointerUVs.glb

> Sidecar-файл лицензии модели golden-корпуса. Часть полей извлечена автоматически из
> встроенных метаданных glTF (`fixtures/check-licenses.mjs`), остальные заполнены вручную.
> Проверено: 2026-07-27, дополнено по первоисточнику 2026-08-14.

- **Файл модели:** AnimationPointerUVs.glb
- **Название (title):** AnimationPointerUVs
- **Автор:** Eric Chadwick (модель и текстуры)
- **Лицензия:** CC BY 4.0 International
- **Copyright (asset.copyright):** © 2024 Darmstadt Graphics Group GmbH, CC BY 4.0 International, created by Eric Chadwick.
- **Источник / URL:** https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/AnimationPointerUVs
- **Generator:** HS glTF exporter for 3dsmax 1.50d (custom3dsmax@gmail.com)

## Условия использования

- **Можно ли распространять (redistributable)?** да
- **Требуется атрибуция?** да (CC BY 4.0)
- **Ссылка на страницу модели/лицензии:** https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/AnimationPointerUVs/README.md

## Что это за модель

Испытательный стенд Khronos для `KHR_animation_pointer`: сдвиг, поворот и масштаб
развёртки анимируются у **21 слота текстур** — базовый цвет, свечение, нормали,
затенение, металличность-шероховатость плюс слоты из расширений материалов
(анизотропия, лак, блеск, зеркальность, пропускание, объём, радужность).

Устроена как таблица для сверки: у каждого материала рядом лежат ДВЕ текстуры —
анимируемая и контрольная неподвижная, — и подписи прямо на модели говорят, какая из
них должна двигаться. То есть модель специально сделана так, чтобы по ней было видно,
что движок умеет, а что нет.

## Почему в нашем вьюпорте движется лишь часть

Это не дефект нашей сборки и не дефект плагина, а предел самой three.js: собственное
преобразование развёртки там есть только у основной карты (`.map`) и карты свечения.
Остальные слоты делят развёртку с основной — отдельной у них нет, анимировать нечего.
Из 21 слота модели three.js способна показать единицы, и подписи на модели как раз это
и покажут.

Где посмотреть, как задумано (оба движка читают расширение сами):

- Эталонный просмотрщик Khronos — https://github.khronos.org/glTF-Sample-Viewer-Release/
- Песочница Babylon.js — https://sandbox.babylonjs.com/ (поддержка встроена в загрузчик,
  `packages/dev/loaders/src/glTF/2.0/Extensions/KHR_animation_pointer.ts`)
