// core/registry.mjs — реестр аддонов формата. Движок формат-агностичен: какой аддон
// обрабатывает файл, решает расширение (.glb/.gltf → gltf-аддон). Пока аддон один
// (gltf, всегда включён и невыключаем — Фаза C), но точка расширения на будущие
// форматы (FBX/USD/...) уже здесь: register(addon) + resolve(path).

import path from 'node:path';

/** @typedef {import('./types.mjs').Addon} Addon */

export class Registry {
  constructor() {
    /** @type {Map<string, Addon>} расширение без точки → аддон */
    this._byFormat = new Map();
    /** @type {Addon[]} порядок регистрации (для listRules по всем аддонам) */
    this._addons = [];
  }

  /** @param {Addon} addon */
  register(addon) {
    if (!addon || !Array.isArray(addon.formats) || !addon.formats.length) {
      throw new Error('registry.register: у аддона должен быть непустой formats[]');
    }
    this._addons.push(addon);
    for (const fmt of addon.formats) {
      this._byFormat.set(String(fmt).toLowerCase().replace(/^\./, ''), addon);
    }
    return this;
  }

  /**
   * Аддон для файла по расширению. Бросает, если формат не поддержан — вызывающий
   * (optimizeFile) превратит это в status:'fail'.
   * @param {string} filePath
   * @returns {Addon}
   */
  resolve(filePath) {
    const ext = path.extname(String(filePath)).toLowerCase().replace(/^\./, '');
    const addon = this._byFormat.get(ext);
    if (!addon) {
      const known = [...this._byFormat.keys()].map((e) => `.${e}`).join(', ') || '(нет зарегистрированных)';
      throw new Error(`Формат .${ext} не поддержан. Доступные: ${known}.`);
    }
    return addon;
  }

  /** Все зарегистрированные аддоны в порядке регистрации. */
  addons() {
    return [...this._addons];
  }
}
