import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  saveCustomProfile, readCustomProfile, deleteCustomProfile, profileTemplate,
  exportCustomProfile, importCustomProfile, getAvailableExtensions,
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
    expect(raw.budgets.triangles).toEqual({ warn: 50000 });
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
    expect(id).toBe('vitrina-zakazchika');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('название на языке вне таблицы даёт служебное имя, а не отказ', () => {
    const { id, file } = saveCustomProfile({ title: '店舗' });
    expect(id, 'id пустой — файл негде хранить и нечего слать в запросе').toBeTruthy();
    expect(id).toMatch(/^[a-z0-9_-]+$/);
    expect(fs.existsSync(file)).toBe(true);
    expect(listPlatforms('ru').find((p) => p.id === id).title).toBe('店舗');
  });

  it('вторая площадка с тем же названием не затирает первую', () => {
    const first = saveCustomProfile({ title: 'Shop', budgets: { triangles: 100 } });
    const second = saveCustomProfile({ title: 'Shop', budgets: { triangles: 200 } });
    expect(second.id, 'вторая площадка получила тот же id и стёрла первую').not.toBe(first.id);
    expect(listPlatforms('ru').filter((p) => p.title === 'Shop').length).toBe(2);
  });
});

describe('площадка вычитает опции, которых у неё нет', () => {
  it('снятая опция исчезает из списка этой площадки', () => {
    const { id } = saveCustomProfile({ title: 'Shop', engine: 'threejs', excludeExtensions: ['draco'] });
    const ids = getAvailableExtensions(id, 'ru').map((e) => e.id);
    expect(ids, 'вычитаемая опция осталась в списке площадки').not.toContain('draco');
    expect(ids.length, 'вычли всё, а не одну опцию').toBeGreaterThan(0);
  });

  it('у площадки без вычитания список полный — как у движка', () => {
    const { id } = saveCustomProfile({ title: 'Shop', engine: 'threejs' });
    const свои = getAvailableExtensions(id, 'ru').map((e) => e.id);
    const движок = getAvailableExtensions('', 'ru', 'threejs').map((e) => e.id);
    expect(свои).toEqual(движок);
  });

  it('пустой список в файл не пишется — поле без смысла путает читателя', () => {
    const { id } = saveCustomProfile({ title: 'Shop', excludeExtensions: [] });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    expect(raw.excludeExtensions).toBeUndefined();
  });

  it('повторы и пустые строки в списке отсеиваются', () => {
    const { id } = saveCustomProfile({
      title: 'Shop', excludeExtensions: ['draco', 'draco', '  ', 'ktx2'],
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    expect(raw.excludeExtensions).toEqual(['draco', 'ktx2']);
  });

  it('вычитание возвращается в форму при правке', () => {
    const { id } = saveCustomProfile({ title: 'Shop', excludeExtensions: ['draco'] });
    expect(readCustomProfile(id, 'ru').excludeExtensions).toEqual(['draco']);
  });

  it('у площадки без вычитания форма получает пустой список, а не undefined', () => {
    const { id } = saveCustomProfile({ title: 'Shop' });
    expect(readCustomProfile(id, 'ru').excludeExtensions).toEqual([]);
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

describe('описание короткое, и вопросов у него два', () => {
  const длинный = 'я'.repeat(151);

  it('описание длиннее предела не принимается — и отказ называет поле', () => {
    try {
      saveCustomProfile({ title: 'Shop', description: длинный });
      expect.unreachable('длинное описание принято');
    } catch (e) {
      expect(e.code).toBe('too_long');
      expect(e.field).toBe('description');
    }
  });

  it('источник длиннее предела не принимается', () => {
    try {
      saveCustomProfile({ title: 'Shop', source: длинный });
      expect.unreachable('длинный источник принят');
    } catch (e) {
      expect(e.code).toBe('too_long');
      expect(e.field).toBe('source');
    }
  });

  it('ровно предел — принимается: граница включительная', () => {
    const { id } = saveCustomProfile({ title: 'Shop', description: 'я'.repeat(150) });
    expect(readCustomProfile(id, 'ru').description.length).toBe(150);
  });

  it('источник лежит в файле ОДИН раз, а не копией у каждого порога', () => {
    const { id } = saveCustomProfile({
      title: 'Shop',
      source: 'https://example.com/limits',
      budgets: { triangles: 100, fileMB: 5, vramMB: 40 },
    });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    expect(raw.source).toBe('https://example.com/limits');
    for (const [key, entry] of Object.entries(raw.budgets)) {
      expect(entry.source, `адрес продублирован в пороге ${key}`).toBeUndefined();
    }
  });

  it('источник доезжает до строк бюджета — и НЕ отменяет пометку «ваш порог»', () => {
    const { id } = saveCustomProfile({
      title: 'Shop', source: 'https://example.com/limits', budgets: { triangles: 50000 },
    });
    const tri = explainResult(runResult, id, 'ru').budgetChecks.find((c) => c.id === 'triangles');
    expect(tri.source, 'источник профиля до порога не доехал').toBe('https://example.com/limits');
    expect(tri.by, 'ссылка вытеснила пометку — своё число снова неотличимо').toBe('user');
  });

  it('у встроенной площадки ссылка есть, а пометки «ваш» нет', () => {
    const shopify = explainResult(runResult, 'shopify', 'ru').budgetChecks
      .find((c) => c.source);
    if (!shopify) return;
    expect(shopify.by, 'встроенный порог помечен как пользовательский').not.toBe('user');
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
    expect(form.budgets).toEqual({ triangles: 50000, textureMaxSize: 2048 });
  });

  it('удаление убирает площадку из списка и файл с диска', () => {
    const { id, file } = saveCustomProfile({ title: 'Shop' });
    deleteCustomProfile(id);
    expect(fs.existsSync(file), 'файл остался на диске').toBe(false);
    expect(listPlatforms('ru').some((p) => p.id === id), 'стёртая площадка осталась в списке').toBe(false);
  });
});

describe('обмен площадками файлом', () => {
  const РУЧНОЙ = {
    id: 'partner',
    engine: 'threejs',
    enabled: true,
    title: { en: 'Partner store', ru: 'Витрина партнёра' },
    budgets: {
      fileMB: { warn: 4, limit: 15, source: 'https://example.com/limits' },
      triangles: { warn: 60000 },
    },
    excludeExtensions: ['draco'],
    baselineOpts: { codec: 'meshopt', texMode: 'mixed', noKtx: true },
    notes: ['числа из письма менеджера, проверены 2026-08-13'],
  };

  it('выгрузка отдаёт файл дословно, а не поля формы', () => {
    const { id } = saveCustomProfile({ title: 'Shop', budgets: { triangles: 100 } });
    const file = path.join(dir, `${id}.json`);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    body.budgets.fileMB = { warn: 4, limit: 15, source: 'https://example.com' };
    body.excludeExtensions = ['draco'];
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');

    const out = exportCustomProfile(id);
    const sent = JSON.parse(out.json);
    expect(out.id).toBe(id);
    expect(sent.budgets.fileMB.limit, 'жёсткий предел не доехал до получателя').toBe(15);
    expect(sent.excludeExtensions, 'список вычитаемых опций потерян').toEqual(['draco']);
  });

  it('встроенную площадку не выгрузить', () => {
    expect(codeOf(() => exportCustomProfile('shopify'))).toBe('builtin_id');
  });

  it('принятый файл сохраняет всё, чего форма не спрашивает', () => {
    const { id, replaced } = importCustomProfile(JSON.stringify(РУЧНОЙ));
    expect(id).toBe('partner');
    expect(replaced, 'новая площадка помечена как обновление существующей').toBe(false);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'partner.json'), 'utf8'));
    expect(saved.budgets.fileMB).toEqual(РУЧНОЙ.budgets.fileMB);
    expect(saved.excludeExtensions).toEqual(['draco']);
    expect(saved.baselineOpts.texMode).toBe('mixed');
    expect(saved.notes).toEqual(РУЧНОЙ.notes);

    const found = listPlatforms('ru').find((p) => p.id === 'partner');
    expect(found.title, 'название взято не на языке интерфейса').toBe('Витрина партнёра');
    expect(found.custom).toBe(true);
  });

  it('повторный ввоз того же файла обновляет площадку и говорит об этом', () => {
    importCustomProfile(JSON.stringify(РУЧНОЙ));
    const again = importCustomProfile(JSON.stringify({ ...РУЧНОЙ, title: 'Partner v2' }));
    expect(again.id).toBe('partner');
    expect(again.replaced, 'перезапись чужим файлом прошла молча').toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 'завёлся второй файл').toBe(1);
    expect(listPlatforms('ru').find((p) => p.id === 'partner').title).toBe('Partner v2');
  });

  it('файл с именем встроенной площадки получает своё имя, а не отказ', () => {
    const { id, replaced } = importCustomProfile(JSON.stringify({ ...РУЧНОЙ, id: 'shopify' }));
    expect(id, 'встроенный id занят — файл обязан лечь под другим именем').not.toBe('shopify');
    expect(replaced).toBe(false);
    const shopify = listPlatforms('ru').filter((p) => p.id === 'shopify');
    expect(shopify.length, 'в списке две площадки с одним id').toBe(1);
    expect(shopify[0].custom, 'встроенная площадка подменена принесённым файлом').toBe(false);
  });

  it('выключенный в файле профиль после ввоза виден', () => {
    const { id } = importCustomProfile(JSON.stringify({ ...РУЧНОЙ, enabled: false }));
    expect(listPlatforms('ru').some((p) => p.id === id), 'принесённая площадка не появилась').toBe(true);
  });

  it('пометку «встроенный» файл себе не выпишет', () => {
    const { id } = importCustomProfile(JSON.stringify({ ...РУЧНОЙ, custom: false }));
    expect(listPlatforms('ru').find((p) => p.id === id).custom).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    expect(saved.custom, 'поле осталось в файле и путает следующего читателя').toBeUndefined();
  });

  it('не-JSON и файл без названия — отказ с причиной', () => {
    expect(codeOf(() => importCustomProfile('это не json'))).toBe('bad_file');
    expect(codeOf(() => importCustomProfile('[1,2,3]'))).toBe('bad_file');
    expect(codeOf(() => importCustomProfile('{"id":"x"}'))).toBe('title_required');
  });

  it('файл без id получает имя из названия', () => {
    const { id } = importCustomProfile(JSON.stringify({ title: 'Витрина заказчика', budgets: {} }));
    expect(id).toBe('vitrina-zakazchika');
  });
});

describe('состав формы не расходится с бюджетами', () => {
  it('поля формы — это метрики бюджета, а не их копия', () => {
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

  it('площадка может называться как угодно, служебных имён нет', () => {
    const { id } = saveCustomProfile({ title: 'Template', budgets: { triangles: 42 } });
    expect(id).toBe('template');
    expect(readCustomProfile(id, 'ru').title).toBe('Template');
    expect(listPlatforms('ru').some((p) => p.id === 'template')).toBe(true);
  });
});


describe('порог: совет или отказ', () => {
  const заведи = (kinds) => saveCustomProfile({
    title: 'Проба порога',
    engine: 'threejs',
    budgets: { fileMB: '20' },
    ...(kinds ? { budgetKinds: kinds } : {}),
  });

  const вФайле = (id) => JSON.parse(
    fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'),
  ).budgets.fileMB;

  it('без ответа порог остаётся советом — умолчание не изменилось', () => {
    expect(вФайле(заведи(null).id)).toEqual({ warn: 20 });
  });

  it('названный отказом порог пишется пределом, а не советом', () => {
    expect(вФайле(заведи({ fileMB: 'limit' }).id)).toEqual({ limit: 20 });
  });

  it('незнакомое значение читается советом, а не отказом', () => {
    expect(вФайле(заведи({ fileMB: 'ерунда' }).id)).toEqual({ warn: 20 });
  });

  it('файл сверх ЖЁСТКОГО порога получает отказ, а не совет', () => {
    const { id } = заведи({ fileMB: 'limit' });
    const тяжёлый = { ...metrics, fileBytes: 75 * 1024 * 1024 };
    const res = explainResult(
      { status: 'ok', metrics: { before: тяжёлый, after: тяжёлый } }, id, 'ru',
    );
    const check = (res.budgetChecks || []).find((c) => c.id === 'fileMB');
    expect(check, 'порога размера файла нет в сверке вовсе').toBeTruthy();
    expect(check.level, 'жёсткий порог сработал как совет').toBe('over');
    expect(check.advice, 'человеку не сказано, что площадка такую модель отклонит')
      .toMatch(/предел|отклоня/i);
  });

  it('тот же файл при МЯГКОМ пороге остаётся предупреждением', () => {
    const { id } = заведи({ fileMB: 'warn' });
    const тяжёлый = { ...metrics, fileBytes: 75 * 1024 * 1024 };
    const res = explainResult(
      { status: 'ok', metrics: { before: тяжёлый, after: тяжёлый } }, id, 'ru',
    );
    const check = (res.budgetChecks || []).find((c) => c.id === 'fileMB');
    expect(check.level).toBe('warn');
  });

  it('строгость возвращается в форму при правке — иначе отказ молча станет советом', () => {
    const { id } = заведи({ fileMB: 'limit' });
    const form = readCustomProfile(id, 'ru');
    expect(form.budgets.fileMB, 'число потерялось').toBe(20);
    expect(form.budgetKinds.fileMB, 'правка чужой площадки размягчила её порог').toBe('limit');
  });

  it('мягкий совет не утверждает за площадку, что она примет такую модель', () => {
    const { id } = заведи({ fileMB: 'warn' });
    const тяжёлый = { ...metrics, fileBytes: 75 * 1024 * 1024 };
    const res = explainResult(
      { status: 'ok', metrics: { before: тяжёлый, after: тяжёлый } }, id, 'ru',
    );
    const check = (res.budgetChecks || []).find((c) => c.id === 'fileMB');
    expect(check.advice, 'совет по-прежнему обещает, что площадка модель примет')
      .not.toMatch(/не предел/i);
  });
});
