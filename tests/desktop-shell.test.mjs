// tests/desktop-shell.test.mjs — оболочка приложения: чужой адрес и сторож запуска.
//
// Ревью 2026-08-10:
//   P1.6   свой адрес отличался от чужого через `url.startsWith(address)`. Начало строки
//          про происхождение не говорит ничего. И `shell.openExternal` получал адрес
//          любой схемы, а система знает не только http.
//   P0.2.1 30-секундный сторож запуска не гасился после удачного старта. Обещание уже
//          выполнено, повторный reject ничего не меняет — но startupError() по дороге
//          ПИШЕТ engine-crash.log. У работающего приложения на диске появлялся отчёт
//          о падении, которого не было.
//
// Про адреса проверяется поведение: desktop/url-policy.cjs не зависит от electron и
// грузится обычным node. Про сторож — исходник main.cjs: он требует electron целиком,
// поднять его в тесте нечем, а оставить дефект без сторожа хуже, чем проверить слабее.
// Проверка сформулирована так, чтобы падать именно от возврата дефекта.

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
    // Каждый из этих адресов начинается с нашего — и ведёт не к нам.
    const tricks = [
      'http://127.0.0.1:3210@evil.com/',  // userinfo: настоящий хост после «собаки»
      'http://127.0.0.1:32100/',          // другой порт, то же начало строки
      'http://127.0.0.1:3210.evil.com/',  // такой адрес вовсе не разбирается
    ];
    for (const url of tricks) {
      // сначала показываем, что старый приём тут ошибался, — иначе проверка
      // доказывала бы не то, ради чего написана
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
      'ms-msdt:/id',      // на Windows такие схемы запускают программы
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
    // `setTimeout(..., 30_000)` без присваивания — это ровно тот дефект: погасить нечем.
    expect(startServer).toMatch(/=\s*setTimeout\([^]*?30_000\)/);
  });

  it('и гасится clearTimeout', () => {
    expect(startServer).toMatch(/clearTimeout\(/);
  });

  it('удачный старт идёт через гасящую обёртку, а не напрямую в resolve', () => {
    // Прямой `resolve({ child` вернул бы дефект: обещание выполнено, таймер жив.
    expect(startServer).not.toMatch(/\bresolve\(\{\s*child/);
  });
});

describe('повторное открытие окна не поднимает второй движок', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  // Ищем сам обработчик, а не упоминание — на него ссылается комментарий выше по файлу.
  const at = src.indexOf("app.on('activate', () => {");
  // до конца самого обработчика, а не «плюс сколько-то символов»: хвост залезал
  // в соседние функции и проверка судила о чужом коде
  // Комментарии убираем: объяснение «раньше здесь звался startServer()» — это рассказ
  // о дефекте, а не его возврат, и без чистки проверка красила бы собственный текст.
  const activate = src.slice(at, src.indexOf('\n  });', at) + 6)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('обработчик нашёлся — иначе проверки ниже ничего не значат', () => {
    expect(at).toBeGreaterThan(-1);
  });

  it('в обработчике activate нет запуска сервера', () => {
    // Второй сервер — это не «лишний процесс». Каждый на старте чистит uploads/ и
    // results/, то есть новый стирает данные, с которыми работает старый.
    expect(activate).not.toMatch(/startServer\(/);
  });

  it('окно открывается по сохранённому адресу работающего движка', () => {
    expect(activate).toMatch(/createWindow\(serverAddress\)/);
    expect(src, 'адрес сервера негде взять — переменная не заполняется')
      .toMatch(/serverAddress\s*=\s*started\.address/);
  });
});

// Рабочие файлы не должны переживать выход из программы (Александр, 2026-08-13:
// «пк клиента не должен замусориваться рабочими файлами в огромном количестве»).
// Сервер чистит папку на СТАРТЕ, и без уборки на выходе гигабайты лежали бы на диске
// всё время, пока программа закрыта, — то есть почти всегда.
describe('рабочая папка не переживает выход из программы', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

  it('уборка привязана к выходу', () => {
    expect(src, 'clearWorkDir не зовётся при выходе — папка остаётся на диске')
      .toMatch(/app\.on\('will-quit',[^\n]*clearWorkDir\(\)/);
  });

  it('убирается именно рабочая папка, а не папка данных целиком', () => {
    // В userData лежат ещё и свои площадки. Снести её целиком значило бы стереть
    // работу человека вместо мусора.
    const at = src.indexOf('function clearWorkDir()');
    expect(at, 'функции уборки нет').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    expect(body).toMatch(/getPath\('userData'\),\s*'work'/);
    expect(body, 'уборка не должна знать про площадки').not.toMatch(/profiles/);
  });

  it('уборка не роняет выход', () => {
    // Файл занят антивирусом — это не повод не закрыться. Следующий запуск всё равно
    // чистит то же самое.
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
    // и старого приёма в файле не осталось
    expect(src).not.toMatch(/url\.startsWith\(address\)/);
  });
});

describe('одна программа — один запущенный экземпляр', () => {
  // Найдено Александром 2026-08-21: «я могу кучи окон запустить одного и того же
  // приложения». Лишнее окно — не главная беда: каждый экземпляр поднимает свой движок,
  // а движок на старте ЧИСТИТ рабочую папку. Папка у всех одна, значит второй запуск
  // стирает загруженные модели и собранные результаты первого — посреди работы и молча.
  //
  // Ту же беду ревью 2026-08-10 (P0.2.2) уже чинило, но только для клика по значку в
  // доке macOS. Через парадную дверь она осталась открытой.
  const MAIN = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');

  it('замок берётся', () => {
    expect(/requestSingleInstanceLock\(\)/.test(MAIN), 'замка нет вовсе').toBe(true);
    expect(/app\.on\('second-instance'/.test(MAIN), 'второму экземпляру нечем ответить').toBe(true);
  });

  it('замок берётся ДО запуска движка — иначе он бессмыслен', () => {
    // Порядок здесь и есть вся суть. Возьми замок после `whenReady` — второй экземпляр
    // успеет поднять сервер и вычистить папку прежде, чем поймёт, что он лишний.
    const lock = MAIN.indexOf('requestSingleInstanceLock()');
    const ready = MAIN.indexOf('app.whenReady()');
    expect(lock, 'замка нет').toBeGreaterThan(-1);
    expect(ready, 'не нашёл запуск — якорь сменился').toBeGreaterThan(-1);
    expect(lock, 'замок берётся ПОСЛЕ запуска движка — он ничего не защищает').toBeLessThan(ready);
  });

  it('без замка запуск движка не происходит вовсе', () => {
    // Мало взять замок — надо ещё не пойти дальше без него. `app.quit()` до готовности
    // не обрывает выполнение немедленно, а обработчик whenReady уже зарегистрирован.
    const m = MAIN.match(/(if \([A-Za-z]*[Ll]ock[A-Za-z]*\)\s*)?app\.whenReady\(\)/);
    expect(m, 'не нашёл запуск').toBeTruthy();
    expect(m[1], 'whenReady зовётся безусловно — второй экземпляр всё равно поднимет движок')
      .toBeTruthy();
  });

  it('второму экземпляру показывают окно первого, а не второе окно', () => {
    // Правильный ответ на повторный запуск — вывести вперёд уже открытое окно. Создать
    // ещё одно значило бы вернуть ровно ту беду, ради которой замок и ставился.
    const handler = MAIN.match(/app\.on\('second-instance'[\s\S]*?\n {2}\}\);/);
    expect(handler, 'обработчика второго запуска нет').toBeTruthy();
    expect(/focus\(\)/.test(handler[0]), 'окно первого экземпляра не выводится вперёд').toBe(true);
    expect(/createWindow\(/.test(handler[0]), 'второй экземпляр открывает ЕЩЁ ОДНО окно').toBe(false);
    // Свёрнутое окно надо сперва развернуть: focus() по свёрнутому не поднимает его, и
    // человек получил бы полное молчание в ответ на запуск.
    expect(/isMinimized\(\)/.test(handler[0]), 'свёрнутое окно останется свёрнутым').toBe(true);
  });
});
