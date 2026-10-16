// ClipForge desktop app: runs the local server in this process and shows it in a window.
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';

const PORT = Number(process.env.PORT || 4317); // fixed: MCP configs and OAuth redirects point here
const ORIGIN = `http://localhost:${PORT}`;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}

async function start() {
  // user data (database, thumbnails, exports, models) outside the read-only app bundle
  process.env.CLIPFORGE_DATA ||= path.join(app.getPath('userData'), 'data');
  process.env.CLIPFORGE_EMBEDDED = '1';
  process.env.PORT = String(PORT);

  const started = new Promise((resolve, reject) => {
    process.once('clipforge:ready', resolve);
    process.once('clipforge:error', reject);
  });
  try {
    await import('../server/index.js');
    await started;
  } catch (err) {
    // another ClipForge (e.g. "npm start" in a terminal) already serves this port: just use it
    const running = await fetch(`${ORIGIN}/api/status`).then((r) => r.ok, () => false);
    if (!running) {
      dialog.showErrorBox('ClipForge', err.code === 'EADDRINUSE'
        ? `Le port ${PORT} est utilisé par un autre programme. Ferme-le puis relance ClipForge.`
        : `Démarrage impossible : ${err.message}`);
      app.quit();
      return;
    }
  }
  createWindow();
}

function isInternal(url) {
  try {
    const u = new URL(url);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === String(PORT);
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'ClipForge',
    backgroundColor: '#0b0e13',
    autoHideMenuBar: true,
    icon: path.join(import.meta.dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(ORIGIN);

  // Links to other sites (Google sign-in, API key pages, TikTok…) open in the user's browser:
  // Google refuses OAuth inside embedded windows.
  const external = (event, url) => {
    if (isInternal(url) && !url.includes('/api/youtube/connect')) return;
    event.preventDefault();
    shell.openExternal(url);
  };
  win.webContents.on('will-navigate', external);
  win.webContents.on('will-redirect', external);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url) && !url.includes('/api/youtube/connect')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}
