// Main-process half of the buzzer connection. The GATT work itself happens in
// the game renderer through Web Bluetooth (src/renderer/game/ble.js); Electron
// needs the main process to:
//   1. pick a device when the renderer calls navigator.bluetooth.requestDevice
//      (there is no browser chooser UI in Electron),
//   2. answer OS pairing prompts (the buzzer uses "Just Works" pairing),
//   3. provide a user gesture, which requestDevice requires.

const SCAN_TIMEOUT_MS = 15000;

export function setupBluetooth(win) {
  const wc = win.webContents;
  const ses = wc.session;
  let scan = null; // { callback, timer }

  ses.setPermissionCheckHandler((_wc, permission) => permission === 'bluetooth' || permission === 'fullscreen');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'bluetooth');

  // Windows / Linux only. Just Works → "confirm"; accept everything that does
  // not need a user-entered PIN.
  ses.setBluetoothPairingHandler?.((details, callback) => {
    if (details.pairingKind === 'providePin') callback({ confirmed: false });
    else callback({ confirmed: true });
  });

  // Fired repeatedly while Chromium scans; the list is already filtered to
  // devices advertising the NUS service UUID the renderer asked for.
  wc.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (!scan) {
      scan = { callback, timer: setTimeout(() => finish(''), SCAN_TIMEOUT_MS) };
    } else {
      scan.callback = callback;
    }
    if (devices.length) finish(devices[0].deviceId);
  });

  function finish(deviceId) {
    if (!scan) return;
    clearTimeout(scan.timer);
    const { callback } = scan;
    scan = null;
    callback(deviceId); // '' cancels → renderer gets NotFoundError and retries later
  }

  return {
    /** Runs the renderer's scan function with a synthetic user gesture. */
    requestScan() {
      if (scan || wc.isDestroyed()) return;
      wc.executeJavaScript('window.__standoffBleScan && window.__standoffBleScan()', true).catch(() => {});
    },
  };
}
