// BrowserWindow factories.
//
//   game      the kiosk screen: fullscreen kiosk in packaged builds, a
//             portrait window in development
//   settings  separate window on top of the game (Ctrl/Cmd + , or the hidden
//             corner button held for N seconds)
//   remote    invisible window that hosts the WebRTC link to the admin page

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = path.join(here, 'preload.cjs');
const devServer = process.env.VITE_DEV_SERVER_URL;

export const isKiosk = () => app.isPackaged || process.env.STANDOFF_KIOSK === '1';

function load(win, page) {
  if (devServer) return win.loadURL(`${devServer}/${page}/index.html`);
  return win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', page, 'index.html'));
}

function harden(win) {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!devServer || !url.startsWith(devServer)) e.preventDefault();
  });
  wc.on('did-finish-load', () => wc.setVisualZoomLevelLimits(1, 1));
}

const webPreferences = (extra = {}) => ({
  preload,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
  ...extra,
});

export function createGameWindow() {
  const kiosk = isKiosk();
  const win = new BrowserWindow({
    title: 'Standoff',
    backgroundColor: '#0C112F',
    show: false,
    ...(kiosk
      ? { kiosk: true, fullscreen: true, frame: false, autoHideMenuBar: true }
      : { width: 540, height: 960, useContentSize: true, autoHideMenuBar: true }),
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  win.once('ready-to-show', () => win.show());
  harden(win);
  load(win, 'game');
  return win;
}

export function createSettingsWindow(parent) {
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(1000, Math.round(area.width * 0.94));
  const height = Math.round(area.height * 0.9);
  const win = new BrowserWindow({
    parent,
    title: 'Standoff — Settings',
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    frame: !isKiosk(),
    alwaysOnTop: isKiosk(),
    autoHideMenuBar: true,
    backgroundColor: '#0C112F',
    show: false,
    webPreferences: webPreferences(),
  });
  if (isKiosk()) win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  harden(win);
  load(win, 'settings');
  return win;
}

export function createRemoteWindow() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: webPreferences({ backgroundThrottling: false }),
  });
  harden(win);
  load(win, 'remote');
  return win;
}
