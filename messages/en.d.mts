// messages/en.d.mts — форма каталога ассистента для TypeScript. Сам каталог остаётся на
// JavaScript (en.mjs) и правится переводчиком напрямую: собранный из .mts файл затирала бы
// каждая сборка. Здесь только форма значения, текста тут нет.

import type { MessageCatalog } from '../core/types.mjs';

declare const messages: MessageCatalog;
export default messages;
