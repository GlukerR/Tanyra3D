import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { isOwnPage, isExternalWeb } = require_(path.join(ROOT, 'desktop', 'url-policy.cjs'));

const ADDRESS = 'http://127.0.0.1:3210';

describe('свой адрес отличается от чужого по origin', () => {
  it('страницы приложения — свои', () => {
    for (const url of [ADDRESS, `${ADDRESS}/`, `${ADDRESS}/index.html`, `${ADDRESS}/api/platforms?lang=ru`]) {
      expect(isOwnPage(url, ADDRESS), url).toBe(true);
    }
  });

  it('то, что обмануло бы startsWith, признаётся чужим', () => {
    const tricks = [
      'http://127.0.0.1:3210@evil.com/',
      'http://127.0.0.1:32100/',
      'http://127.0.0.1:3210.evil.com/',
    ];
    for (const url of tricks) {
      expect(url.startsWith(ADDRESS), `${url} — не тот случай, startsWith и так против`).toBe(true);
      expect(isOwnPage(url, ADDRESS), url).toBe(false);
    }
  });

  it('другая схема — другой origin', () => {
    expect(isOwnPage('https://127.0.0.1:3210/', ADDRESS)).toBe(false);
  });

  it('мусор вместо адреса не считается своим', () => {
    for (const url of ['', 'не адрес', 'javascript:alert(1)', null, undefined]) {
      expect(isOwnPage(url, ADDRESS), String(url)).toBe(false);
    }
  });
});

describe('наружу отдаём только веб-адреса', () => {
  it('http и https проходят', () => {
    expect(isExternalWeb('https://github.com/KhronosGroup/glTF')).toBe(true);
    expect(isExternalWeb('http://example.org/doc')).toBe(true);
  });

  it('остальные схемы не проходят', () => {
    const denied = [
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'ms-msdt:/id',
      'smb://host/share',
      'не адрес',
      '',
    ];
    for (const url of denied) expect(isExternalWeb(url), url).toBe(false);
  });
});

describe('сторож запуска гасится', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const startServer = src.slice(src.indexOf('function startServer'), src.indexOf('function createWindow'));

  it('30-секундный таймер сохраняется в переменную, а не выбрасывается', () => {
    expect(startServer).toMatch(/=\s*setTimeout\([^]*?30_000\)/);
  });

  it('и гасится clearTimeout', () => {
    expect(startServer).toMatch(/clearTimeout\(/);
  });

  it('удачный старт идёт через гасящую обёртку, а не напрямую в resolve', () => {
    expect(startServer).not.toMatch(/\bresolve\(\{\s*child/);
  });
});

describe('повторное открытие окна не поднимает второй движок', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const at = src.indexOf("app.on('activate', () => {");
  const activate = src.slice(at, src.indexOf('\n  });', at) + 6)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('обработчик нашёлся — иначе проверки ниже ничего не значат', () => {
    expect(at).toBeGreaterThan(-1);
  });

  it('в обработчике activate нет запуска сервера', () => {
    expect(activate).not.toMatch(/startServer\(/);
  });

  it('окно открывается по сохранённому адресу работающего движка', () => {
    expect(activate).toMatch(/createWindow\(serverAddress\)/);
    expect(src, 'адрес сервера негде взять — переменная не заполняется')
      .toMatch(/serverAddress\s*=\s*started\.address/);
  });
});

describe('рабочая папка не переживает выход из программы', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

  it('уборка привязана к выходу', () => {
    expect(src, 'clearWorkDir не зовётся при выходе — папка остаётся на диске')
      .toMatch(/app\.on\('will-quit',[^\n]*clearWorkDir\(\)/);
  });

  it('убирается именно рабочая папка, а не папка данных целиком', () => {
    const at = src.indexOf('function clearWorkDir()');
    expect(at, 'функции уборки нет').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toMatch(/getPath\('userData'\),\s*'work'/);
    expect(body, 'уборка не должна знать про площадки').not.toMatch(/profiles/);
  });

  it('уборка не роняет выход', () => {
    const at = src.indexOf('function clearWorkDir()');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/catch/);
  });
});

describe('модуль политики адресов доедет до собранного пакета', () => {
  it('desktop/ входит в состав сборки', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const files = (pkg.build && pkg.build.files) || [];
    expect(files.some((f) => String(f).startsWith('desktop/'))).toBe(true);
  });

  it('main.cjs действительно берёт решение оттуда, а не из своей копии', () => {
    const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
    expect(src).toMatch(/require\('\.\/url-policy\.cjs'\)/);
    expect(src).not.toMatch(/url\.startsWith\(address\)/);
  });
});


describe('падение движка НА ХОДУ оставляет чем разбираться', () => {
  const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');


  it('вывод движка собирается всегда, а не только до открытия окна', () => {
    expect(MAIN, 'сбор вывода снова гасится флагом — после запуска буфер будет пуст')
      .not.toMatch(/\bcollectLog\b/);
    const push = MAIN.match(/const pushLog = \(chunk\) => \{[\s\S]*?\n\};/);
    expect(push, 'не нашёл pushLog — якорь сменился').toBeTruthy();
    expect(push[0], 'pushLog снова пишет по условию').not.toMatch(/if \(\w*[Ll]og\)/);
  });

  it('буфер ограничен — иначе он растёт часами', () => {
    expect(MAIN, 'предел буфера не назван').toMatch(/LOG_TAIL_LINES\s*=\s*\d+/);
    const push = MAIN.match(/const pushLog = \(chunk\) => \{[\s\S]*?\n\};/)[0];
    expect(push, 'pushLog не подрезает буфер — он будет расти без предела')
      .toMatch(/LOG_TAIL_LINES/);
  });

  it('при смерти на ходу пишется отчёт, а не только показывается код', () => {
    const i = MAIN.indexOf("serverProcess.removeAllListeners('exit')");
    expect(i, 'не нашёл замену сторожа запуска — якорь сменился').toBeGreaterThan(-1);
    const handler = MAIN.slice(i, i + 900);
    expect(handler, 'падение на ходу снова не оставляет файла с выводом движка')
      .toContain('saveCrashLog()');
    expect(handler, 'человеку не сказали, где искать отчёт').toMatch(/file \?/);
  });
});
describe('одна программа — один запущенный экземпляр', () => {
  const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

  it('замок берётся', () => {
    expect(/requestSingleInstanceLock\(\)/.test(MAIN), 'замка нет вовсе').toBe(true);
    expect(/app\.on\('second-instance'/.test(MAIN), 'второму экземпляру нечем ответить').toBe(true);
  });

  it('замок берётся ДО запуска движка — иначе он бессмыслен', () => {
    const lock = MAIN.indexOf('requestSingleInstanceLock()');
    const ready = MAIN.indexOf('app.whenReady()');
    expect(lock, 'замка нет').toBeGreaterThan(-1);
    expect(ready, 'не нашёл запуск — якорь сменился').toBeGreaterThan(-1);
    expect(lock, 'замок берётся ПОСЛЕ запуска движка — он ничего не защищает').toBeLessThan(ready);
  });

  it('без замка запуск движка не происходит вовсе', () => {
    const m = MAIN.match(/(if \([A-Za-z]*[Ll]ock[A-Za-z]*\)\s*)?app\.whenReady\(\)/);
    expect(m, 'не нашёл запуск').toBeTruthy();
    expect(m[1], 'whenReady зовётся безусловно — второй экземпляр всё равно поднимет движок')
      .toBeTruthy();
  });

  it('второму экземпляру показывают окно первого, а не второе окно', () => {
    const handler = MAIN.match(/app\.on\('second-instance'[\s\S]*?\n {2}\}\);/);
    expect(handler, 'обработчика второго запуска нет').toBeTruthy();
    expect(/focus\(\)/.test(handler[0]), 'окно первого экземпляра не выводится вперёд').toBe(true);
    expect(/isMinimized\(\)/.test(handler[0]), 'свёрнутое окно останется свёрнутым').toBe(true);

    expect(/startServer\(/.test(handler[0]), 'второй запуск поднимает свой движок').toBe(false);
  });

  it('окно создаётся только когда его НЕТ — и на работающем движке', () => {
    const handler = MAIN.match(/app\.on\('second-instance'[\s\S]*?\n {2}\}\);/)[0];
    const create = handler.match(/if \(!mainWindow\) \{[\s\S]*?\n {4}\}/);
    if (/createWindow\(/.test(handler)) {
      expect(create, 'createWindow в обработчике есть, но не под проверкой «окна нет»').toBeTruthy();
      expect(/createWindow\(/.test(create[0]), 'окно создаётся вне ветки «окна нет»').toBe(true);
      expect(/serverAddress/.test(create[0]), 'окно открывается, не убедившись, что движок работает').toBe(true);
      expect((handler.match(/createWindow\(/g) || []).length, 'createWindow зовётся больше одного раза').toBe(1);
    }
  });
});
