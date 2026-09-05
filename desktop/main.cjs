const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { isOwnPage, isExternalWeb } = require('./url-policy.cjs');

const ROOT = app.getAppPath();
const SERVER = path.join(ROOT, 'server.mjs');

const TOOLS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'tools')
  : path.join(__dirname, '..', '.tools');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      if (serverAddress) createWindow(serverAddress);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}


let serverProcess = null;
let mainWindow = null;
let serverAddress = null;

const LOG_TAIL_LINES = 200;
const serverLog = [];
const pushLog = (chunk) => {
  serverLog.push(String(chunk));
  if (serverLog.length > LOG_TAIL_LINES) serverLog.splice(0, serverLog.length - LOG_TAIL_LINES);
};

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
    return null;
  }
}

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
      PORT: '0',
      TANYRA_NO_BROWSER: '1',
      ELECTRON_RUN_AS_NODE: '1',
    };
    if (fs.existsSync(TOOLS_DIR)) env.TANYRA_TOOLS_DIR = TOOLS_DIR;

    env.TANYRA_DATA_DIR = path.join(app.getPath('userData'), 'work');

    const child = fork(SERVER, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

    child.stdout.on('data', (b) => { process.stdout.write(`[server] ${b}`); pushLog(b); });
    child.stderr.on('data', (b) => { process.stderr.write(`[server] ${b}`); pushLog(b); });

    let startupTimer = null;
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      fn(...args);
    };
    const done = settle(resolve);
    const fail = settle((e) => {
      if (!child.killed && child.exitCode === null) { try { child.kill(); } catch {  } }
      reject(e);
    });

    child.on('message', (m) => {
      if (m && m.type === 'listening') done({ child, address: m.address });
    });
    child.on('error', fail);
    child.once('exit', (code) => {
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      if (settled) return;
      settled = true;
      setTimeout(() => reject(startupError(`Движок остановился с кодом ${code}, не открыв порт`)), 100);
    });

    startupTimer = setTimeout(() => fail(startupError('Движок не отозвался за 30 секунд')), 30_000);
  });
}

function createWindow(address) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1b1b1f',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(address);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url, address)) return;
    e.preventDefault();
    if (isExternalWeb(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

if (gotTheLock) app.whenReady().then(async () => {
  try {
    const started = await startServer();
    serverProcess = started.child;
    serverAddress = started.address;
    serverLog.length = 0;
    serverProcess.removeAllListeners('exit');
    serverProcess.on('exit', (code) => {
      if (code === 0 || app.isQuitting) return;
      const file = saveCrashLog();
      dialog.showErrorBox('Tanyra3D', [
        `Движок остановился (код ${code}). Закройте окно и запустите программу заново.`,
        file ? `\nЧто он сказал перед этим — в файле:\n${file}` : '',
      ].join('\n'));
    });
    createWindow(started.address);
  } catch (e) {
    dialog.showErrorBox('Tanyra3D', `Не удалось запустить движок.\n\n${e.message}`);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverAddress) {
      createWindow(serverAddress);
    }
  });
});

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function clearWorkDir() {
  const work = path.join(app.getPath('userData'), 'work');
  let entries;
  try { entries = fs.readdirSync(work); } catch { return; }
  for (const entry of entries) {
    try { fs.rmSync(path.join(work, entry), { recursive: true, force: true }); } catch {  }
  }
}

app.on('before-quit', () => { app.isQuitting = true; stopServer(); });
app.on('will-quit', () => { stopServer(); clearWorkDir(); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
