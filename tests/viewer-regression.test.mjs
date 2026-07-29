// tests/viewer-regression.test.mjs — статические проверки исходников вьюера.
//
// Браузерного окружения (@vitest/browser, playwright, jsdom, happy-dom) в проекте
// нет, поэтому поведенческие тесты (WebGL, загрузка модели, клик по панели)
// невозможны. Вместо них — проверка текста ИСХОДНИКОВ `ui/viewer/` на предмет
// ключевых паттернов, которые уже ломались в прошлом (см. коммит 125faa2).
//
// Это СТОРОЖЕВЫЕ проверки, не доказательство работы. Они падают при откате
// критических участков, но не гарантируют, что всё действительно работает.
//
// Проверяемые дефекты (все три исправлены в 125faa2):
//   1. Клип анимации расходился — правый вьюпорт после сборки начинал с клипа №0.
//   2. Настройки камеры расходились — near/far/minDistance/maxDistance не передавались.
//   3. Панель анимации зависела от requestAnimationFrame — не появлялась в фоновой вкладке.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// 1. viewer.js — getCameraState() возвращает все поля камеры
// ---------------------------------------------------------------
//
// До 125faa2 getCameraState() возвращал только position и target.
// Без near/far правый вьюпорт загружался с чужими плоскостями отсечения:
// (0.01/1000 из конструктора) вместо (dist/100) из frame().
// Расстояние до среза деталей различалось между окнами — выглядело как
// дефект оптимизации.

describe('viewer.js — getCameraState completeness', () => {
  const viewerPath = path.resolve(PROJECT_ROOT, 'ui/viewer/viewer.js');

  it('exists and readable', () => {
    expect(fs.existsSync(viewerPath)).toBe(true);
    const text = fs.readFileSync(viewerPath, 'utf-8');
    expect(text.length).toBeGreaterThan(0);
  });

  it('getCameraState() returns near, far, minDistance, maxDistance', () => {
    const text = fs.readFileSync(viewerPath, 'utf-8');
    // Ищем блок return внутри getCameraState — он должен включать все пять полей.
    const match = text.match(/getCameraState\(\s*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('position');
    expect(block).toContain('target');
    expect(block).toContain('near:');
    expect(block).toContain('far:');
    expect(block).toContain('minDistance:');
    expect(block).toContain('maxDistance:');
  });
});

// ---------------------------------------------------------------
// 2. viewer.js — applyCameraState() применяет near/far и вызывает
//    updateProjectionMatrix()
// ---------------------------------------------------------------

describe('viewer.js — applyCameraState sets near/far and updates projection', () => {
  const viewerPath = path.resolve(PROJECT_ROOT, 'ui/viewer/viewer.js');

  it('applyCameraState assigns camera.near, camera.far and calls updateProjectionMatrix()', () => {
    const text = fs.readFileSync(viewerPath, 'utf-8');
    // Проверяем, что файл содержит уникальные строки из applyCameraState.
    // Вложенные `{ }` (if) внутри функции делают регекс-матчинг ненадёжным,
    // поэтому проверяем по всему файлу — каждой строки достаточно для sentinel.
    expect(text).toContain('Number.isFinite(state.near)');
    expect(text).toContain('Number.isFinite(state.far)');
    expect(text).toContain('camera.near = state.near');
    expect(text).toContain('camera.far = state.far');
    expect(text).toContain('camera.updateProjectionMatrix()');
    expect(text).toContain('controls.minDistance = state.minDistance');
    expect(text).toContain('controls.maxDistance = state.maxDistance');
  });
});

// ---------------------------------------------------------------
// 3. viewer.js — frame() задаёт near/far/minDistance/maxDistance
// ---------------------------------------------------------------

describe('viewer.js — frame() sets clipping planes and zoom limits', () => {
  const viewerPath = path.resolve(PROJECT_ROOT, 'ui/viewer/viewer.js');

  it('frame() assigns camera.near, camera.far, minDistance, maxDistance', () => {
    const text = fs.readFileSync(viewerPath, 'utf-8');
    const match = text.match(/frame\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('camera.near =');
    expect(block).toContain('camera.far =');
    expect(block).toContain('updateProjectionMatrix');
    expect(block).toContain('controls.minDistance =');
    expect(block).toContain('controls.maxDistance =');
  });
});

// ---------------------------------------------------------------
// 4. viewer.js — setExposure() валидирует значение, откатывает на 1
// ---------------------------------------------------------------

describe('viewer.js — setExposure validation', () => {
  const viewerPath = path.resolve(PROJECT_ROOT, 'ui/viewer/viewer.js');

  it('setExposure() validates input, falls back to 1 for non-finite values', () => {
    const text = fs.readFileSync(viewerPath, 'utf-8');
    const match = text.match(/setExposure\s*\(\s*value\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('Number.isFinite');
    expect(block).toContain('toneMappingExposure');
    expect(block).toContain(': 1');
  });
});

// ---------------------------------------------------------------
// 5. index.js — DualViewport хранит _animClipIndex и применяет его
//    в _applyAnimSelection() при загрузке модели
// ---------------------------------------------------------------

describe('index.js — DualViewport animation clip state', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('DualViewport constructor initializes _animClipIndex', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/constructor\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('_animClipIndex');
    expect(block).toContain('0');
  });

  it('selectAnimationClip() stores index in _animClipIndex', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/selectAnimationClip\s*\(\s*index\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('_animClipIndex');
    expect(block).toContain('playClip');
  });

  it('_applyAnimSelection() stores _animClipIndex and synchronizes clip on both viewports', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    // Проверяем весь файл (не тело функции) — каждая строка достаточно
    // специфична для sentinel-проверки.
    expect(text).toContain('_applyAnimSelection');
    expect(text).toContain('this._animClipIndex');
    expect(text).toContain('playClip?.(idx)');
    expect(text).toContain('_advanceAnimation');
  });

  it('_afterLoad() calls _applyAnimSelection() and _notifyLoaded()', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/_afterLoad\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('_applyAnimSelection');
    expect(block).toContain('_notifyLoaded');
  });
});

// ---------------------------------------------------------------
// 6. index.js — resetView() кадрирует ОДИН вьюпорт и копирует
//    состояние во второй
// ---------------------------------------------------------------

describe('index.js — resetView sync mechanism', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('resetView() frames one viewport and applies camera state to the other', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/resetView\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    // Комментарий явно описывает подход
    expect(block).toContain('frame()');
    expect(block).toContain('getCameraState');
    expect(block).toContain('applyCameraState');
    // Не должно быть двух независимых frame() — это был старый баг
    const frameMatches = block.match(/\.frame\s*\(\s*\)/g);
    expect(frameMatches).not.toBeNull();
    expect(frameMatches.length).toBe(1);
  });
});

// ---------------------------------------------------------------
// 7. index.js — обновление панели через _notifyLoaded(), а не из rAF
// ---------------------------------------------------------------

describe('index.js — panel update via _notifyLoaded (not rAF)', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('_notifyLoaded() calls this._onLoaded or window.onOptiViewerModelLoaded', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/_notifyLoaded\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('_onLoaded');
    expect(block).toContain('onOptiViewerModelLoaded');
  });

  it('setOnLoaded stores the callback reference', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/setOnLoaded\s*\([\s\S]*?\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('_onLoaded');
    expect(block).toContain('typeof');
  });
});

// ---------------------------------------------------------------
// 8. index.js — getAnimation() отдаёт leftIndex и rightIndex
// ---------------------------------------------------------------

describe('index.js — getAnimation() exposes both clip indices', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('getAnimation() returns leftIndex and rightIndex', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/getAnimation\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('leftIndex');
    expect(block).toContain('rightIndex');
  });
});

// ---------------------------------------------------------------
// 9. index.js — экспозиция применяется к ОБОИМ вьюпортам
// ---------------------------------------------------------------

describe('index.js — exposure applies to both viewports', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('_applyExposure() applies to left AND right viewers', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/_applyExposure\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('left');
    expect(block).toContain('right');
    expect(block).toContain('setExposure');
  });

  it('setExposure() clamps value to [0.05, 4]', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/setExposure\s*\(\s*value\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('0.05');
    expect(block).toContain('4');
  });
});

// ---------------------------------------------------------------
// 10. index.js — _advanceAnimation ставит ОДНО время на оба вьюпорта
// ---------------------------------------------------------------

describe('index.js — animation time sync across viewports', () => {
  const indexPath = path.resolve(PROJECT_ROOT, 'ui/viewer/index.js');

  it('_advanceAnimation() calls setAnimationTime on both left and right', () => {
    const text = fs.readFileSync(indexPath, 'utf-8');
    const match = text.match(/_advanceAnimation\s*\(\s*dt\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(match).not.toBeNull();
    const block = match[0];
    expect(block).toContain('left');
    expect(block).toContain('right');
    expect(block).toContain('setAnimationTime');
  });
});
