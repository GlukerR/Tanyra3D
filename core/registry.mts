// core/registry.mts — реестр аддонов формата. Движок формат-агностичен: какой аддон
// обрабатывает файл, решает расширение (.glb/.gltf → gltf-аддон). Пока аддон один
// (gltf, всегда включён и невыключаем — Фаза C), но точка расширения на будущие
// форматы (FBX/USD/...) уже здесь: register(addon) + resolve(path).
//
// Переведён на TypeScript 2026-08-11, третьим после types и contract. Модуль выбран
// намеренно: пятьдесят строк, ни одной зависимости кроме node:path, и полный гейт
// поведения в tests/architecture/registry.test.mjs — то есть перевод проверяем не
// «на глаз», а существующим набором.

import path from 'node:path';

import type { Addon } from './types.mjs';

export class Registry {
  /** расширение без точки → аддон */
  private readonly _byFormat = new Map<string, Addon>();
  /** порядок регистрации (для listRules по всем аддонам) */
  private readonly _addons: Addon[] = [];

  // Проверка формата остаётся во время работы, хотя тип параметра её как будто
  // повторяет: половина дерева (optimize2.mjs, тесты) — по-прежнему JavaScript, и
  // оттуда сюда может прийти что угодно. Тип помогает тому, кто уже на TypeScript;
  // бросок — всем остальным.
  register(addon: Addon): this {
    const formats = (addon as Partial<Addon> | null | undefined)?.formats;
    if (!Array.isArray(formats) || !formats.length) {
      throw new Error('registry.register: у аддона должен быть непустой formats[]');
    }
    this._addons.push(addon);
    for (const fmt of formats) {
      this._byFormat.set(String(fmt).toLowerCase().replace(/^\./, ''), addon);
    }
    return this;
  }

  /**
   * Аддон для файла по расширению. Бросает, если формат не поддержан — вызывающий
   * (optimizeFile) превратит это в status:'fail'.
   */
  resolve(filePath: string): Addon {
    const ext = path.extname(String(filePath)).toLowerCase().replace(/^\./, '');
    const addon = this._byFormat.get(ext);
    if (!addon) {
      const known = [...this._byFormat.keys()].map((e) => `.${e}`).join(', ') || '(none registered)';
      throw new Error(`Format .${ext} is not supported. Available: ${known}.`);
    }
    return addon;
  }

  /** Все зарегистрированные аддоны в порядке регистрации. */
  addons(): Addon[] {
    return [...this._addons];
  }
}
