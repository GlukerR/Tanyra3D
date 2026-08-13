// tests/profile-form.test.mjs — своя площадка составляется формой (ROADMAP.md §5i, шаг 2).
//
// Шаг 1 дал папку, куда можно положить свой профиль. Здесь проверяется то, что кладёт
// туда сама программа: человек называет площадку, выбирает движок и пишет несколько
// чисел — файл собирается за него.
//
// Сторожатся обещания, каждое из которых легко нарушить незаметно:
//   1. форма спрашивает ровно то, чего вывести неоткуда (имя, движок, числа), а список
//      полей не расходится с метриками бюджета;
//   2. встроенную площадку формой не подменить и не стереть;
//   3. пустое поле — законное «порога нет», а не ноль;
//   4. профиль, не назвавший базовый план, получает его от движка (иначе площадка из
//      формы осталась бы без плана обработки).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  saveCustomProfile, readCustomProfile, deleteCustomProfile, profileTemplate,
  listPlatforms, explainResult, planFor, ProfileError,
} from '../assistant.mjs';

let dir;
let saved;

beforeEach(() => {
  saved = process.env.TANYRA3D_PROFILES_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-form-'));
  process.env.TANYRA3D_PROFILES_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TANYRA3D_PROFILES_DIR;
  else process.env.TANYRA3D_PROFILES_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const metrics = {
  fileBytes: 20 * 1024 * 1024,
  gpuBytes: 1,
  triangles: 999999,
  materials: 1,
  drawCalls: 1,
  textureMaxSize: 4096,
};
const runResult = { status: 'ok', metrics: { before: metrics, after: metrics } };

/** Отказ формы: код нужен интерфейсу, чтобы подобрать фразу на своём языке. */
function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    expect(e, 'форма отказала не своей ошибкой — интерфейсу нечего показать').toBeInstanceOf(ProfileError);
    return e.code;
  }
  return null;
}

describe('форма создаёт рабочую площадку', () => {
  it('сохранённая площадка появляется в списке и помечена как своя', () => {
    const { id } = saveCustomProfile({ title: 'Мебель на заказ', engine: 'threejs' });
    const found = listPlatforms('ru').find((p) => p.id === id);
    expect(found, 'созданной площадки нет в списке').toBeTruthy();
    expect(found.title).toBe('Мебель на заказ');
    expect(found.custom, 'своя площадка не помечена — интерфейс не отличит её от встроенной').toBe(true);
  });

  it('файл лежит в пользовательской папке и читается как обычный профиль', () => {
    const { id, file } = saveCustomProfile({ title: 'Shop', budgets: { triangles: 50000 } });
    expect(path.dirname(file), 'файл лёг мимо пользовательской папки').toBe(dir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.id).toBe(id);
    expect(raw.enabled, 'созданная площадка выключена и потому невидима').toBe(true);
    // Пороги пишутся объектом: рядом с warn человек дописывает limit руками.
    expect(raw.budgets.triangles).toEqual({ warn: 50000 });
    // Пометку «свой» ставит загрузчик по тому, откуда взят файл, — в файле её нет.
    expect(raw.custom, 'файл объявил себя своим сам').toBeUndefined();
  });

  it('её пороги сверяются и помечены как ваши, а не как выверенные по документу', () => {
    const { id } = saveCustomProfile({ title: 'Shop', budgets: { triangles: 50000 } });
    const tri = explainResult(runResult, id, 'ru').budgetChecks.find((c) => c.id === 'triangles');
    expect(tri.level, '999 999 треугольников при пороге 50 000 — это жёлтый').toBe('warn');
    expect(tri.by, 'придуманное число выдано за выверенное по первоисточнику').toBe('user');
    expect(tri.source).toBeUndefined();
  });

  it('план обработки берётся у движка — форма про кодек не спрашивает', () => {
    const { id } = saveCustomProfile({ title: 'Shop', engine: 'threejs' });
    const plan = planFor(id, 'ru');
    expect(plan.engineOpts.codec, 'площадка из формы осталась без базового плана').toBeTruthy();
    expect(plan.availableExtensions.length, 'у своей площадки пустой список опций').toBeGreaterThan(0);
  });

  it('название из одной кириллицы даёт осмысленное имя файла', () => {
    const { id, file } = saveCustomProfile({ title: 'Витрина заказчика' });
    expect(id, 'id должен быть латиницей: он ездит в адресе запроса').toMatch(/^[a-z0-9_-]+$/);
    // Именем файла делятся (§5i, шаг 3), и папку форма показывает человеку —
    // «platform-3.json» вместо названия площадки был бы плохим подарком коллеге.
    expect(id).toBe('vitrina-zakazchika');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('название на языке вне таблицы даёт служебное имя, а не отказ', () => {
    const { id, file } = saveCustomProfile({ title: '店舗' });
    expect(id, 'id пустой — файл негде хранить и нечего слать в запросе').toBeTruthy();
    expect(id).toMatch(/^[a-z0-9_-]+$/);
    expect(fs.existsSync(file)).toBe(true);
    // Площадка от имени файла не зависит: в списке стоит название, как его написали.
    expect(listPlatforms('ru').find((p) => p.id === id).title).toBe('店舗');
  });

  it('вторая площадка с тем же названием не затирает первую', () => {
    const first = saveCustomProfile({ title: 'Shop', budgets: { triangles: 100 } });
    const second = saveCustomProfile({ title: 'Shop', budgets: { triangles: 200 } });
    expect(second.id, 'вторая площадка получила тот же id и стёрла первую').not.toBe(first.id);
    expect(listPlatforms('ru').filter((p) => p.title === 'Shop').length).toBe(2);
  });
});

describe('пустое поле — это «порога нет»', () => {
  it('незаполненные числа не превращаются в ноль', () => {
    const { id } = saveCustomProfile({
      title: 'Shop',
      budgets: { triangles: 50000, fileMB: '', vramMB: null, drawCalls: undefined },
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    expect(Object.keys(raw.budgets), 'пустое поле стало порогом').toEqual(['triangles']);

    const checks = explainResult(runResult, id, 'ru').budgetChecks;
    expect(checks.find((c) => c.id === 'fileMB'), 'у метрики без порога появилась оценка').toBeUndefined();
  });

  it('ноль и отрицательное — отказ, а не «нет порога»', () => {
    expect(codeOf(() => saveCustomProfile({ title: 'Shop', budgets: { triangles: 0 } }))).toBe('bad_number');
    expect(codeOf(() => saveCustomProfile({ title: 'Shop', budgets: { fileMB: -5 } }))).toBe('bad_number');
    expect(codeOf(() => saveCustomProfile({ title: 'Shop', budgets: { fileMB: 'много' } }))).toBe('bad_number');
  });

  it('отказ называет поле — иначе человеку негде искать опечатку', () => {
    try {
      saveCustomProfile({ title: 'Shop', budgets: { vramMB: -1 } });
      expect.unreachable('отрицательный порог принят');
    } catch (e) {
      expect(e.field).toBe('vramMB');
    }
  });
});

describe('чего форма не даст сделать', () => {
  it('площадка без названия не создаётся', () => {
    expect(codeOf(() => saveCustomProfile({ title: '   ' }))).toBe('title_required');
    expect(codeOf(() => saveCustomProfile({}))).toBe('title_required');
  });

  it('несуществующий движок — отказ: площадке нечем предложить опции', () => {
    expect(codeOf(() => saveCustomProfile({ title: 'Shop', engine: 'unreal' }))).toBe('engine_unknown');
  });

  it('встроенную площадку не перезаписать', () => {
    expect(codeOf(() => saveCustomProfile({ id: 'shopify', title: 'ПОДМЕНА' }))).toBe('builtin_id');
    const shopify = listPlatforms('ru').find((p) => p.id === 'shopify');
    expect(shopify.title, 'встроенная площадка подменена').not.toBe('ПОДМЕНА');
  });

  it('встроенную площадку не стереть и не открыть на правку', () => {
    expect(codeOf(() => deleteCustomProfile('shopify'))).toBe('builtin_id');
    expect(codeOf(() => readCustomProfile('shopify'))).toBe('builtin_id');
    expect(listPlatforms('ru').some((p) => p.id === 'shopify'), 'встроенная площадка исчезла').toBe(true);
  });

  it('несуществующую площадку не стереть', () => {
    expect(codeOf(() => deleteCustomProfile('нет-такой'))).toBe('unknown_profile');
  });
});

describe('правка и удаление своей площадки', () => {
  it('сохранение с тем же id правит файл, а не заводит второй', () => {
    const { id } = saveCustomProfile({ title: 'Shop', budgets: { triangles: 100 } });
    const again = saveCustomProfile({ id, title: 'Shop поновее', budgets: { triangles: 777 } });
    expect(again.id).toBe(id);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 'правка завела второй файл').toBe(1);
    const found = listPlatforms('ru').filter((p) => p.id === id);
    expect(found[0].title).toBe('Shop поновее');
  });

  it('своя площадка открывается обратно в поля формы', () => {
    const { id } = saveCustomProfile({
      title: 'Shop', engine: 'threejs', description: 'Витрина заказчика',
      budgets: { triangles: 50000, textureMaxSize: 2048 },
    });
    const form = readCustomProfile(id, 'ru');
    expect(form).toMatchObject({
      id, title: 'Shop', engine: 'threejs', description: 'Витрина заказчика',
    });
    // В форму возвращается голое число, а не запись профиля: поле ввода — для числа.
    expect(form.budgets).toEqual({ triangles: 50000, textureMaxSize: 2048 });
  });

  it('удаление убирает площадку из списка и файл с диска', () => {
    const { id, file } = saveCustomProfile({ title: 'Shop' });
    deleteCustomProfile(id);
    expect(fs.existsSync(file), 'файл остался на диске').toBe(false);
    expect(listPlatforms('ru').some((p) => p.id === id), 'стёртая площадка осталась в списке').toBe(false);
  });
});

describe('состав формы не расходится с бюджетами', () => {
  it('поля формы — это метрики бюджета, а не их копия', () => {
    // Список полей берётся из BUDGET_SPEC. Проверяем не побуквенное совпадение, а то,
    // ради чего это сделано: каждое поле формы действительно доезжает до сверки.
    const tpl = profileTemplate('ru');
    const budgets = Object.fromEntries(tpl.fields.map((f) => [f.id, 1]));
    const { id } = saveCustomProfile({ title: 'Shop', budgets });
    const ids = explainResult(runResult, id, 'ru').budgetChecks.map((c) => c.id);
    for (const f of tpl.fields) {
      expect(ids, `поле формы «${f.id}» до сверки не доехало`).toContain(f.id);
    }
  });

  it('у каждого поля есть подпись на языке интерфейса', () => {
    const ru = profileTemplate('ru');
    const en = profileTemplate('en');
    for (const f of ru.fields) {
      expect(f.name, `поле ${f.id} без подписи`).toBeTruthy();
      expect(f.name, `подпись поля ${f.id} — это ключ каталога, а не строка`).not.toBe(f.id);
    }
    const ruNames = ru.fields.map((f) => f.name).join('|');
    const enNames = en.fields.map((f) => f.name).join('|');
    expect(ruNames, 'подписи полей не переводятся').not.toBe(enNames);
  });

  it('единицы стоят у тех полей, где число само за себя не говорит', () => {
    const byId = Object.fromEntries(profileTemplate('ru').fields.map((f) => [f.id, f.unit]));
    expect(byId.fileMB, 'размер файла без единицы').toBeTruthy();
    expect(byId.textureMaxSize, 'сторона текстуры без единицы').toBeTruthy();
    expect(byId.triangles, 'к числу треугольников приписана единица').toBe('');
  });

  it('форма называет ту же папку, куда кладут файлы руками', () => {
    expect(profileTemplate('ru').dir).toBe(dir);
  });

  // Служебных имён у площадок нет: описание формы отдаёт сам /api/profiles, а не
  // вложенный путь. Иначе площадка, названная «Template», перекрыла бы его собой.
  it('площадка может называться как угодно, служебных имён нет', () => {
    const { id } = saveCustomProfile({ title: 'Template', budgets: { triangles: 42 } });
    expect(id).toBe('template');
    expect(readCustomProfile(id, 'ru').title).toBe('Template');
    expect(listPlatforms('ru').some((p) => p.id === 'template')).toBe(true);
  });
});
