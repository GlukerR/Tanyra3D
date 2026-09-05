import path from 'node:path';

import type { Addon } from './types.mjs';

export class Registry {
  private readonly _byFormat = new Map<string, Addon>();
  private readonly _addons: Addon[] = [];

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

  resolve(filePath: string): Addon {
    const ext = path.extname(String(filePath)).toLowerCase().replace(/^\./, '');
    const addon = this._byFormat.get(ext);
    if (!addon) {
      const known = [...this._byFormat.keys()].map((e) => `.${e}`).join(', ') || '(none registered)';
      throw new Error(`Format .${ext} is not supported. Available: ${known}.`);
    }
    return addon;
  }

  addons(): Addon[] {
    return [...this._addons];
  }
}
