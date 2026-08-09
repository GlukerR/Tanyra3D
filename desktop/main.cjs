// desktop/main.cjs — оболочка настольного приложения.
//
// Зачем она вообще нужна. Программа и без неё работает: `npm start` поднимает сервер и
// открывает страницу в браузере. Но до этого человеку надо поставить Node, склонировать
// репозиторий, выполнить четыре команды в терминале и на Windows обойти запрет на
// выполнение сценариев. Художник, ради которого всё это писалось, до второго шага не
// доходит. Оболочка убирает ровно эти шаги и больше ничего: внутри тот же сервер, та же
// страница, тот же движок.
//
// Почему оболочка тонкая. Она не знает ни про glTF, ни про правила, ни про отчёты —
// только запускает сервер и показывает его в окне. Это продолжение того же разделения,
// что между ядром и аддоном: у окна нет причин знать, что оно показывает.
//
// CommonJS, а не ESM: в package.json стоит "type": "module", и главный процесс Electron
// надёжнее держать в .cjs, чем полагаться на поддержку ESM в конкретной версии.

const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Корень спрашиваем у Electron, а не вычисляем сами. Он разный в трёх случаях —
// запуск из исходников, собранный пакет с asar, собранный без него, — и угадывать
// его руками значит ошибиться в одном из трёх. Первая версия так и ошиблась:
// вычисляла путь внутрь app.asar, которого нет, потому что архив выключен.
const ROOT = app.getAppPath();
const SERVER = path.join(ROOT, 'server.mjs');

// Куда положен ktx. В собранном пакете — в ресурсы (см. extraResources в package.json),
// при запуске из исходников — привычная `.tools/` в корне.
const TOOLS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'tools')
  : path.join(__dirname, '..', '.tools');

let serverProcess = null;
let mainWindow = null;

// Весь вывод движка с начала запуска. Растёт только до открытия окна: дальше сервер
// работает часами, и держать его журнал в памяти незачем.
const serverLog = [];
let collectLog = true;
const pushLog = (chunk) => { if (collectLog) serverLog.push(String(chunk)); };

/** Файл с полным выводом — то, что человек может приложить к сообщению о поломке. */
function saveCrashLog() {
  try {
    const file = path.join(app.getPath('userData'), 'engine-crash.log');
    fs.writeFileSync(file, [
      `Tanyra3D ${app.getVersion()} · ${new Date().toISOString()}`,
      `${process.platform} ${process.arch} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
      `Папка программы: ${ROOT}`,
      `Инструменты: ${TOOLS_DIR} (${fs.existsSync(TOOLS_DIR) ? 'на месте' : 'НЕТ'})`,
      '',
      serverLog.join('') || '(движок не сказал ни слова)',
    ].join('\n'), 'utf8');
    return file;
  } catch {
    return null;      // некуда писать — не повод падать поверх падения
  }
}

/**
 * Ошибка запуска вместе с тем, что успел сказать движок.
 *
 * Без хвоста вывода сообщение бесполезно одинаково для всех: и для человека, который
 * видит только код, и для того, кто чинит. Причина отказа при запуске почти всегда
 * стоит в последних строках — не найден модуль, не сошлась нативная сборка, занят
 * порт, нет прав на папку.
 */
function startupError(headline) {
  const tail = serverLog.join('').trim().split('\n').slice(-12).join('\n');
  const file = saveCrashLog();
  return new Error([
    headline,
    tail ? `\nЧто сказал движок:\n${tail}` : '\nДвижок не сказал ничего.',
    file ? `\nПолный отчёт: ${file}` : '',
  ].join('\n'));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      // Порт выбирает система. Фиксированный занят, если человек уже запустил программу
      // из терминала, — и окно молча не открылось бы.
      PORT: '0',
      // Страница уже показана в окне; второй раз в браузере она не нужна.
      TANYRA_NO_BROWSER: '1',
      // Сервер запускается бинарником Electron. Без этой переменной тот считает себя
      // приложением и не выполняет переданный сценарий. Она же наследуется дальше — в
      // дочерний процесс gltf-transform CLI, который сервер зовёт тем же execPath.
      ELECTRON_RUN_AS_NODE: '1',
    };
    if (fs.existsSync(TOOLS_DIR)) env.TANYRA_TOOLS_DIR = TOOLS_DIR;

    const child = fork(SERVER, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    // Вывод сервера — в консоль оболочки И в кольцевой буфер.
    //
    // Консоли у оконной программы нет: на Windows её не видит никто, и до 2026-08-09
    // это означало, что при отказе запуска настоящая ошибка пропадала бесследно.
    // Человек получал «сервер завершился с кодом 1» — сообщение, по которому нельзя
    // ни понять причину, ни рассказать о ней тому, кто чинит. Александр так и написал:
    // «вышла ошибка, не удалось запустить движок».
    //
    // Буфер маленький: причина падения при импорте — это последние несколько строк,
    // а не весь журнал. Полный вывод всё равно уходит в файл (см. saveCrashLog).
    child.stdout.on('data', (b) => { process.stdout.write(`[server] ${b}`); pushLog(b); });
    child.stderr.on('data', (b) => { process.stderr.write(`[server] ${b}`); pushLog(b); });

    // Сервер сам сообщает адрес: порт выдала система, заранее его не знает никто.
    child.on('message', (m) => {
      if (m && m.type === 'listening') resolve({ child, address: m.address });
    });
    child.on('error', reject);
    child.once('exit', (code) => {
      // Дать последним строкам stderr дойти до нас: 'exit' приходит раньше, чем
      // опустеет труба, и без этой отсрочки в отчёт попадала бы пустота.
      setTimeout(() => reject(startupError(`Движок остановился с кодом ${code}, не открыв порт`)), 100);
    });

    // Если сервер не отозвался — виснуть в пустом окне хуже, чем сказать вслух.
    setTimeout(() => reject(startupError('Движок не отозвался за 30 секунд')), 30_000);
  });
}

function createWindow(address) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1b1b1f', // до первой отрисовки — не белая вспышка
    show: false,
    webPreferences: {
      // Странице не нужен доступ ни к Node, ни к файловой системе: она разговаривает с
      // сервером по HTTP, ровно как в браузере. Значит и давать его незачем.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(address);

  // Внешние ссылки (документация, лицензии) — в настоящий браузер, а не подменой
  // страницы приложения: вернуться из неё было бы нечем, меню у окна нет.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(address)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const started = await startServer();
    serverProcess = started.child;
    collectLog = false;   // запустился — дальше журнал в памяти не нужен
    serverLog.length = 0;
    // Первый обработчик exit был одноразовым сторожем запуска; дальше падение сервера —
    // это уже не «не смог открыться», а «умер на ходу», и говорить надо другое.
    serverProcess.removeAllListeners('exit');
    serverProcess.on('exit', (code) => {
      if (code !== 0 && !app.isQuitting) {
        dialog.showErrorBox('Tanyra3D', `Движок остановился (код ${code}). Закройте окно и запустите программу заново.`);
      }
    });
    createWindow(started.address);
  } catch (e) {
    dialog.showErrorBox('Tanyra3D', `Не удалось запустить движок.\n\n${e.message}`);
    app.quit();
  }

  app.on('activate', () => {
    // macOS: клик по значку в доке при закрытых окнах — обычай платформы.
    if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
      startServer().then((s) => createWindow(s.address)).catch(() => {});
    }
  });
});

// Сервер — дочерний процесс, сам он не уйдёт. Осиротевший, он держит порт и продолжает
// занимать память после того, как окно закрыто.
function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.on('before-quit', () => { app.isQuitting = true; stopServer(); });
app.on('will-quit', stopServer);
app.on('window-all-closed', () => {
  // macOS держит приложение живым без окон — там это норма, а не утечка.
  if (process.platform !== 'darwin') app.quit();
});
