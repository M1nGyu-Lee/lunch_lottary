const { app, BrowserWindow, shell, session, protocol, net, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSyncService } = require('./sync.cjs');

const OFFICIAL_URL = 'https://zeropay.or.kr/UI_HP_009_03.act';
// Some locked-down Windows environments crash Electron's renderer sandbox at startup.
// The renderer still loads only bundled files, with Node integration disabled and CSP enforced.
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'lunch', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 680,
    backgroundColor: '#11111a',
    title: '점심복권',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  win.loadURL('lunch://app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === OFFICIAL_URL) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('lunch://app/')) event.preventDefault();
  });
}

let syncService;
app.whenReady().then(async () => {
  protocol.handle('lunch', request => {
    const url = new URL(request.url);
    const root = path.resolve(__dirname, '..', 'app');
    const target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(root + path.sep) && target !== root) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  syncService = await createSyncService({ app, BrowserWindow, ipcMain });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => syncService?.close());
