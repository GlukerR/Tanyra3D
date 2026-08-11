// addons/gltf/messages/ru.d.mts — форма каталога для TypeScript. Сам каталог остаётся на
// JavaScript (ru.mjs) и правится переводчиком напрямую (assistants/translate/): сделать
// его собранным из .mts значит подставить переводчика — его правка попала бы в файл,
// который затрёт следующая сборка. Здесь только форма значения, текста тут нет.
//
// Файл рукописный, в отличие от .d.mts рядом с переведёнными модулями: те генерируются
// и в git не идут, этот — идёт.

import type { MessageCatalog } from '../../../core/types.mjs';

declare const messages: MessageCatalog;
export default messages;
