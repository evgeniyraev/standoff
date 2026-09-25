// Main-process half of the buzzer connection. The GATT work itself happens in
// the game renderer through Web Bluetooth (src/renderer/game/ble.js); Electron
// needs the main process to:
//   1. pick a device when the renderer calls navigator.bluetooth.requestDevice
//      (there is no browser chooser UI in Electron),
//   2. answer OS pairing prompts (the buzzer uses "Just Works" pairing),
//   3. provide a user gesture, which requestDevice requires.

import { IPC } from '../shared/protocol.js';

const SCAN_TIMEOUT_MS = 15000;

export function setupBluetooth(win) {
  const wc = win.webContents;
  const ses = wc.session;
  let scan = null; // { callback, timer, seen }

  // Mirrored into the game renderer's BLE log (Settings → System → Buzzers).
  const log = (msg, level = 'info') => {
    console.log(`[ble] ${msg}`);
    if (!wc.isDestroyed()) wc.send(IPC.GAME_COMMAND, { name: 'ble:log', msg, level });
  };

  ses.setPermissionCheckHandler((_wc, permission) => permission === 'bluetooth' || permission === 'fullscreen');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'bluetooth');

  // Windows / Linux only. Just Works → "confirm" (needs the
  // WebBluetoothConfirmPairingSupport feature, enabled in main.js). Happens once
  // per PC; the OS keeps the bond afterwards. Accept everything that does not
  // need a user-entered PIN.
  ses.setBluetoothPairingHandler?.((details, callback) => {
    const accept = details.pairingKind !== 'providePin';
    log(`Pairing request: kind=${details.pairingKind} device=${details.deviceId} → ${accept ? 'accepted' : 'rejected (PIN not supported)'}`,
      accept ? 'info' : 'error');
    callback({ confirmed: accept });
  });

  // Fired repeatedly while Chromium scans; the list is already filtered to
  // devices advertising the NUS service UUID the renderer asked for.
  wc.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (!scan) {
      log(`Chooser opened, scanning up to ${SCAN_TIMEOUT_MS / 1000}s`);
      scan = { callback, timer: setTimeout(() => finish(''), SCAN_TIMEOUT_MS), seen: '' };
    } else {
      scan.callback = callback;
    }
    // Fires on every advertisement; only log when the candidate list changes.
    const seen = devices.map((d) => `"${d.deviceName || '(no name)'}" ${d.deviceId}`).join(', ');
    if (seen !== scan.seen) {
      scan.seen = seen;
      log(`Candidates with NUS service: ${seen || 'none yet'}`);
    }
    if (devices.length) finish(devices[0].deviceId);
  });

  function finish(deviceId) {
    if (!scan) return;
    log(deviceId ? `Selected ${deviceId}` : 'Scan timed out — no device advertising the NUS service', deviceId ? 'info' : 'error');
    clearTimeout(scan.timer);
    const { callback } = scan;
    scan = null;
    callback(deviceId); // '' cancels → renderer gets NotFoundError and retries later
  }

  return {
    /** Runs the renderer's scan function with a synthetic user gesture. */
    log,
    requestScan() {
      if (wc.isDestroyed()) return;
      if (scan) return log('Scan already running, request ignored');
      wc.executeJavaScript('window.__standoffBleScan && window.__standoffBleScan()', true).catch(() => {});
    },
  };
}
