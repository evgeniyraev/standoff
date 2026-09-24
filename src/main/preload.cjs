// The only bridge between the renderers (game, settings, remote) and the main
// process. Renderers run sandboxed with contextIsolation; they see exactly
// the `window.standoff` API below.

const { contextBridge, ipcRenderer } = require('electron');

// Keep in sync with src/shared/protocol.js (preload is sandboxed CommonJS and
// cannot import the ES module).
const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_CHANGED: 'config:changed',
  STATUS_GET: 'status:get',
  STATUS_REPORT: 'status:report',
  STATUS_CHANGED: 'status:changed',
  COMMAND: 'command',
  GAME_COMMAND: 'game:command',
  BLE_SCAN: 'ble:scan',
  REMOTE_PARAMS: 'remote:params',
};

const subscribe = (channel) => (cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('standoff', {
  getConfig: () => ipcRenderer.invoke(IPC.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(IPC.CONFIG_SET, patch),
  onConfig: subscribe(IPC.CONFIG_CHANGED),

  getStatus: () => ipcRenderer.invoke(IPC.STATUS_GET),
  reportStatus: (partial) => ipcRenderer.send(IPC.STATUS_REPORT, partial),
  onStatus: subscribe(IPC.STATUS_CHANGED),

  command: (name, args) => ipcRenderer.invoke(IPC.COMMAND, name, args),
  onGameCommand: subscribe(IPC.GAME_COMMAND),

  bleScan: () => ipcRenderer.send(IPC.BLE_SCAN),
  getRemoteParams: () => ipcRenderer.invoke(IPC.REMOTE_PARAMS),
});
