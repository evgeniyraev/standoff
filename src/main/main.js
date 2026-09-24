// Main process entry. Owns: configuration (source of truth), aggregated
// status, window lifecycle, keyboard shortcuts, auto-start and auto-update.
// See docs/ARCHITECTURE.md for the full picture.

import os from 'node:os';
import { app, ipcMain, powerSaveBlocker } from 'electron';
import { ConfigStore } from './config-store.js';
import { getBuildInfo } from './build-info.js';
import { setupBluetooth } from './bluetooth.js';
import { createUpdater } from './updater.js';
import { createGameWindow, createRemoteWindow, createSettingsWindow, isKiosk } from './windows.js';
import { COMMANDS, IPC, REMOTE_APP_ID } from '../shared/protocol.js';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let store;
let gameWin = null;
let settingsWin = null;
let remoteWin = null;
let bluetooth;
let updater;
let quitting = false;

const status = {
  app: {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    hostname: os.hostname(),
    commit: null,
  },
  game: { screen: 'start' },
  ble: { state: 'idle' },
  update: { state: 'idle' },
  remote: { state: 'idle' },
};

const allWindows = () => [gameWin, settingsWin, remoteWin].filter((w) => w && !w.isDestroyed());
const broadcast = (channel, payload) => allWindows().forEach((w) => w.webContents.send(channel, payload));

function reportStatus(section, value) {
  status[section] = { ...status[section], ...value };
  broadcast(IPC.STATUS_CHANGED, status);
  if (section === 'game') updater?.onGameScreen(status.game.screen);
}

// ---- settings window --------------------------------------------------------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = createSettingsWindow(gameWin);
  attachShortcuts(settingsWin);
  settingsWin.on('closed', () => {
    settingsWin = null;
    gameWin?.focus();
  });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

// Ctrl/Cmd + , toggles settings; F12 opens devtools in development.
function attachShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && input.key === ',') {
      event.preventDefault();
      if (win === settingsWin) closeSettings();
      else openSettings();
    }
    if (!app.isPackaged && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// ---- commands ---------------------------------------------------------------

async function runCommand(name, args, { fromRemote = false } = {}) {
  const def = COMMANDS[name];
  if (!def) throw new Error(`Unknown command: ${name}`);
  if (fromRemote && !def.remote) throw new Error(`Command not allowed remotely: ${name}`);
  switch (name) {
    case 'game:reset':
      gameWin?.webContents.send(IPC.GAME_COMMAND, { name: 'reset' });
      break;
    case 'ble:reconnect':
      gameWin?.webContents.send(IPC.GAME_COMMAND, { name: 'ble:reconnect' });
      break;
    case 'update:check':
      updater.check();
      break;
    case 'update:install':
      updater.install();
      break;
    case 'remote:reconnect':
      remoteWin?.webContents.reload();
      break;
    case 'app:restart':
      quitting = true;
      app.relaunch();
      app.exit(0);
      break;
    case 'app:quit':
      quitting = true;
      app.quit();
      break;
    case 'settings:open':
      openSettings();
      break;
    case 'settings:close':
      closeSettings();
      break;
  }
  return { ok: true };
}

// ---- IPC ----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(IPC.CONFIG_GET, () => store.get());
  ipcMain.handle(IPC.CONFIG_SET, (_e, patch) => store.update(patch));
  ipcMain.handle(IPC.STATUS_GET, () => status);
  ipcMain.on(IPC.STATUS_REPORT, (e, partial) => {
    // Each renderer may only report the sections it owns.
    const owner = e.sender === gameWin?.webContents ? ['game', 'ble'] : e.sender === remoteWin?.webContents ? ['remote'] : [];
    for (const [section, value] of Object.entries(partial ?? {})) {
      if (owner.includes(section)) reportStatus(section, value);
    }
  });
  // Commands arriving through the remote window came from the admin page.
  ipcMain.handle(IPC.COMMAND, (e, name, args) => runCommand(name, args, { fromRemote: e.sender === remoteWin?.webContents }));
  ipcMain.on(IPC.BLE_SCAN, () => {
    // Electron's unsigned dev binary on macOS has no NSBluetoothAlwaysUsageDescription,
    // so touching Bluetooth aborts the process. Use the keyboard fallback there.
    if (process.platform === 'darwin' && !app.isPackaged && process.env.STANDOFF_BLE !== '1') {
      gameWin?.webContents.send(IPC.GAME_COMMAND, { name: 'ble:unavailable', reason: 'Bluetooth disabled in macOS dev (set STANDOFF_BLE=1 to force)' });
      return;
    }
    bluetooth?.requestScan();
  });
  ipcMain.handle(IPC.REMOTE_PARAMS, () => {
    const info = getBuildInfo();
    const cfg = store.get().remote;
    return {
      enabled: cfg.enabled,
      room: cfg.roomOverride || info.room,
      pin: cfg.pinOverride || info.pin,
      appId: REMOTE_APP_ID,
    };
  });
}

// ---- lifecycle ----------------------------------------------------------------

function createGame() {
  gameWin = createGameWindow();
  attachShortcuts(gameWin);
  bluetooth = setupBluetooth(gameWin);
  gameWin.on('close', (e) => {
    if (isKiosk() && !quitting) e.preventDefault(); // Alt+F4 must not kill the kiosk
  });
  gameWin.on('closed', () => {
    gameWin = null;
    if (!quitting) app.quit();
  });
  // A crashed renderer should come back on its own.
  gameWin.webContents.on('render-process-gone', () => gameWin?.webContents.reload());
}

function createRemote() {
  remoteWin = createRemoteWindow();
  remoteWin.webContents.on('render-process-gone', () => remoteWin?.webContents.reload());
  remoteWin.on('closed', () => (remoteWin = null));
}

app.on('second-instance', () => gameWin?.focus());
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  store = new ConfigStore(app.getPath('userData'));
  store.on('change', (cfg) => broadcast(IPC.CONFIG_CHANGED, cfg));
  status.app.commit = getBuildInfo().commit;

  registerIpc();
  createGame();
  createRemote();

  updater = createUpdater({
    isPackaged: app.isPackaged,
    getGameScreen: () => status.game.screen,
    report: (s) => reportStatus('update', s),
  });

  if (app.isPackaged) {
    // Start with Windows (HKCU Run key). Re-applied every launch so the path
    // stays correct after updates.
    app.setLoginItemSettings({ openAtLogin: true });
    powerSaveBlocker.start('prevent-display-sleep');
  }
});

