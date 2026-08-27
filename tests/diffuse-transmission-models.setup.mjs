// tests/diffuse-transmission-models.setup.mjs — globalSetup browser-проекта.
//
// Ничего не собирает. Единственное дело — сказать браузерному тесту, есть ли на диске
// модели, без которых ему не о чем спорить.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ КАНАЛ. `DiffuseTransmissionTeacup.glb` и `DiffuseTransmissionPlant.glb`
// — образцы Khronos: в git их нет и не будет (Правило 0 — чужие модели в публичный
// репозиторий не едут; см. `REPO_MODELS` в `tests/helpers/model-files.mjs`). На чистом
// клоне и на CI они отсутствуют ЗАКОННО. Проверить это прямо в тесте нельзя: он
// исполняется в Chromium, `node:fs` ему недоступен — для того канал и нужен.
//
// ПОЧЕМУ НЕ `throw`. История 2026-08-09: globalSetup, который бросал на отсутствующей
// модели, валил весь browser-проект ДО сбора тестов — 13 красных прогонов подряд с
// «No test files found». Отсутствие локальной модели — не поломка, а норма.
//
// ЦЕНА НАЗВАНА ЧЕСТНО: на CI эти восемь проверок не идут. Они держат ПОКАЗ, а показ
// проверяется на машине, где модели лежат, — там же, где его и смотрят глазами.

import { isPresent } from './helpers/model-files.mjs';

const МОДЕЛИ = ['DiffuseTransmissionTeacup.glb', 'DiffuseTransmissionPlant.glb'];

export async function setup(project) {
  const нет = МОДЕЛИ.filter((m) => !isPresent(m));
  if (нет.length) {
    console.warn(
      '[diffuse-transmission-models.setup] нет локально: ' + нет.join(', ') +
        ' — проверки просвета насквозь пропущены (норма на чистом клоне и на CI)',
    );
  }
  project.provide('diffuse-transmission-models-available', нет.length === 0);
}
