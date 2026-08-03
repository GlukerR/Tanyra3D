// tests/architecture/registry.test.mjs — гейт шва второго формата (АРХИТЕКТУРНЫЕ_ТЕСТЫ.md §5.3).
//
// registry — готовый Plugin API: register(addon) / resolve(path) / addons().
// Задача гейта — ЗАЩИЩАТЬ существующий шов (core/registry.mjs §2.2), а не строить
// новый: регистрация второго формата (FBX/USD/...) не должна требовать правки
// реестра. Проверяем и контракт самого реестра (непустой formats[]), и seam:
// выдуманный аддон с форматом 'fbx' ложится рядом с gltf без изменений реестра.

import { describe, it, expect } from 'vitest';
import { Registry } from '../../core/registry.mjs';
import gltfAddon from '../../addons/gltf/index.mjs';

describe('registry — реестр аддонов формата', () => {
  it('register отклоняет аддон без непустого formats[]', () => {
    const r = new Registry();
    expect(() => r.register({})).toThrow(/formats/);
    expect(() => r.register({ formats: [] })).toThrow(/formats/);
    expect(() => r.register({ formats: 'glb' })).toThrow(/formats/); // не массив
  });

  it('resolve возвращает аддон по расширению файла (без точки, регистронезависимо)', () => {
    const r = new Registry().register(gltfAddon);
    expect(r.resolve('model.glb')).toBe(gltfAddon);
    expect(r.resolve('scene.GLTF')).toBe(gltfAddon);
    expect(r.resolve('/abs/path/Model.GLB')).toBe(gltfAddon);
  });

  it('resolve неизвестного формата бросает с понятным сообщением', () => {
    const r = new Registry().register(gltfAddon);
    expect(() => r.resolve('model.fbx')).toThrow(/Format \.fbx is not supported/);
    expect(() => r.resolve('model.fbx')).toThrow(/\.glb/); // список доступных
  });

  it('addons() возвращает аддоны в порядке регистрации', () => {
    const r = new Registry().register(gltfAddon);
    expect(r.addons()).toEqual([gltfAddon]);
  });

  it('addons() отдаёт копию — мутация снаружи не влияет на реестр', () => {
    const r = new Registry().register(gltfAddon);
    const list = r.addons();
    list.push({ formats: ['fake'] });
    expect(r.addons()).toEqual([gltfAddon]);
  });
});

describe('registry — шов второго формата (§2.2, §5.3)', () => {
  // Выдуманный аддон: достаточно formats + rules, реестру больше ничего не нужно.
  const fakeFbx = { formats: ['fbx'], rules: [], name: 'fake-fbx' };

  it('второй формат регистрируется рядом с gltf без правки реестра', () => {
    const r = new Registry().register(gltfAddon).register(fakeFbx);
    expect(r.resolve('model.fbx')).toBe(fakeFbx);
    expect(r.resolve('model.glb')).toBe(gltfAddon); // первый не задет
    expect(r.addons()).toEqual([gltfAddon, fakeFbx]); // порядок регистрации
  });

  it('префикс точки и регистр расширения нормализуются', () => {
    const r = new Registry().register(fakeFbx);
    expect(r.resolve('a.FBX')).toBe(fakeFbx);
    expect(r.resolve('a.fbx')).toBe(fakeFbx);
  });

  it('один и тот же аддон может заявлять несколько расширений', () => {
    const multi = { formats: ['usdz', 'usda'], rules: [] };
    const r = new Registry().register(multi);
    expect(r.resolve('x.usdz')).toBe(multi);
    expect(r.resolve('x.usda')).toBe(multi);
  });
});
