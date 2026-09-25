// Buzzer device over Web Bluetooth. Protocol: see pc-app-ble-integration.md.
//
//   app → device  START           arm the buttons for one round
//   app → device  PING            every 2 s while idle (LED "alive" blink)
//   device → app  BTN:<id>:<seq>  first press of the round (id 1|2)
//   device → app  STATE:<name>    device state change (informational)
//
// Lifecycle: scan (via main process, needs a user gesture) → connect →
// subscribe TX → ready. On disconnect: reconnect with backoff; after several
// failures forget the device object and scan again.

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write commands
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // indications
const PING_MS = 2000;
const RESCAN_MS = 5000;
const MAX_RECONNECTS = 5;
const MAX_WRITE_FAILURES = 3; // consecutive failed writes → drop the link and reconnect
const LOG_SIZE = 50; // entries kept in status.ble.log (shown in Settings → System)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Buzzers {
  constructor({ onButton, onStatus }) {
    this.onButton = onButton;
    this.onStatus = onStatus;
    this.enabled = false;
    this.autoReconnect = true;
    this.device = null;
    this.rx = null;
    this.lastSeq = null;
    this.failures = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.writeFailures = 0;
    this.writeStrikes = 0; // write-failure rounds since the last successful write
    this.repairNext = false;
    // Chromium hands back the same device/characteristic objects across scans
    // and reconnects; listen on each only once or every event fires N times.
    this.hooked = new WeakSet();
    this.status = { state: 'idle', device: null, error: null, deviceState: null, log: [] };
    this.queue = Promise.resolve(); // GATT writes must not overlap
    window.__standoffBleScan = () => this.scan();
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /** Appends a line to the rolling connection log (also mirrored to the console). */
  log(msg, level = 'info') {
    (level === 'error' ? console.warn : console.log)(`[ble] ${msg}`);
    this.setStatus({ log: [...this.status.log, { t: Date.now(), level, msg }].slice(-LOG_SIZE) });
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.log(enabled ? 'Bluetooth buzzers enabled' : 'Bluetooth buzzers disabled');
    if (enabled) this.requestScan();
    else {
      clearTimeout(this.retryTimer);
      this.device?.gatt?.disconnect();
      this.setStatus({ state: 'disabled' });
    }
  }

  setAutoReconnect(on) {
    if (on === this.autoReconnect) return;
    this.autoReconnect = on;
    this.log(on ? 'Auto-reconnect on' : 'Auto-reconnect off');
    // Turned back on while idle after a drop → pick up where it stopped.
    if (on && this.enabled && this.status.state === 'disconnected') this.connect();
  }

  requestScan({ repair = false } = {}) {
    if (!this.enabled) return;
    if (!navigator.bluetooth) {
      this.log('navigator.bluetooth is missing — Web Bluetooth not available', 'error');
      return this.setStatus({ state: 'unsupported', error: 'Web Bluetooth not available' });
    }
    this.setStatus({ state: 'scanning', error: null });
    this.log(repair ? 'Requesting scan + Windows re-pair from main process' : 'Requesting scan from main process');
    // Main process pairs with Windows, then calls this.scan() with a user gesture.
    window.standoff.bleScan({ repair });
  }

  async scan() {
    this.log(`Scanning for NUS service ${NUS_SERVICE}`);
    try {
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SERVICE] }] });
      this.log(`Found device "${device.name ?? '(no name)'}" id=${device.id}`);
      this.device = device;
      if (!this.hooked.has(device)) {
        this.hooked.add(device);
        device.addEventListener('gattserverdisconnected', () => {
          if (this.device === device) this.onDisconnected();
        });
      }
      this.failures = 0;
      await this.connect();
    } catch (err) {
      if (!this.autoReconnect) return this.stopRetrying(`Scan failed: ${err.name}: ${err.message}`);
      this.log(`Scan failed: ${err.name}: ${err.message} — rescanning in ${RESCAN_MS / 1000}s`, 'error');
      this.setStatus({ state: 'not-found', error: err.message });
      this.retry(() => this.requestScan(), RESCAN_MS);
    }
  }

  async connect() {
    if (!this.device) return this.requestScan();
    this.setStatus({ state: 'connecting', device: this.device.name || this.device.id });
    let step = 'GATT connect';
    try {
      this.log(`Connecting (attempt ${this.failures + 1})…`);
      const server = await this.device.gatt.connect();
      step = 'discover NUS service';
      this.log('GATT connected, discovering NUS service');
      const service = await server.getPrimaryService(NUS_SERVICE);
      step = 'get RX characteristic';
      this.rx = await service.getCharacteristic(NUS_RX);
      step = 'get TX characteristic';
      const tx = await service.getCharacteristic(NUS_TX);
      const props = Object.entries({ write: tx.properties.write, notify: tx.properties.notify, indicate: tx.properties.indicate })
        .filter(([, on]) => on)
        .map(([k]) => k);
      this.log(`RX/TX found (TX props: ${props.join(', ') || 'none'}); subscribing (may trigger pairing)`);
      // Re-subscribe on every connection: CCCD state is not guaranteed to survive.
      step = 'subscribe TX (encrypted — pairing)';
      if (!this.hooked.has(tx)) {
        this.hooked.add(tx);
        tx.addEventListener('characteristicvaluechanged', (e) => this.onMessage(decoder.decode(e.target.value)));
      }
      await tx.startNotifications();
      this.failures = 0;
      this.writeFailures = 0;
      this.log('Subscribed to TX — connected and ready');
      this.setStatus({ state: 'connected', error: null });
    } catch (err) {
      // Connected-then-rejected on the encrypted op is the bond-mismatch
      // signature (see integration guide §3).
      this.rx = null;
      this.log(`Failed at "${step}": ${err.name}: ${err.message}`, 'error');
      this.setStatus({ state: 'error', error: `${step}: ${err.message}` });
      this.onDisconnected();
    }
  }

  onDisconnected() {
    this.rx = null;
    if (!this.enabled) return;
    if (!this.autoReconnect) return this.stopRetrying('Disconnected');
    this.failures += 1;
    if (this.failures > MAX_RECONNECTS) {
      this.log(`Gave up after ${MAX_RECONNECTS} reconnects — forgetting device, full rescan`, 'error');
      this.device = null; // stale handle → full rescan
      this.failures = 0;
      return this.retry(() => this.requestScan(), RESCAN_MS);
    }
    const delay = Math.min(10_000, 1000 * this.failures);
    this.log(`Disconnected — reconnecting in ${delay / 1000}s (failure ${this.failures}/${MAX_RECONNECTS})`, 'error');
    this.setStatus({ state: 'reconnecting' });
    this.retry(() => this.connect(), delay);
  }

  stopRetrying(reason) {
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.log(`${reason} — auto-reconnect is off; press "Reconnect buzzers" to try again`, 'error');
    this.setStatus({ state: 'disconnected' });
  }

  retry(fn, ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(fn, ms);
  }

  reconnect() {
    this.log('Manual reconnect requested');
    clearTimeout(this.retryTimer);
    this.failures = 0;
    const device = this.device;
    this.device = null; // before disconnect, so its event doesn't schedule a reconnect too
    this.rx = null;
    device?.gatt?.disconnect();
    this.requestScan();
  }

  onMessage(raw) {
    const msg = raw.trim();
    this.log(`← ${msg}`);
    const btn = /^BTN:(\d+):(\d+)$/.exec(msg);
    if (btn) {
      const seq = Number(btn[2]);
      if (seq === this.lastSeq) return; // duplicate after reconnect
      this.lastSeq = seq;
      this.setStatus({ lastButton: { player: Number(btn[1]), seq, at: Date.now() } });
      this.onButton(Number(btn[1]));
      return;
    }
    const state = /^STATE:(.+)$/.exec(msg);
    if (state) this.setStatus({ deviceState: state[1] });
  }

  send(command) {
    this.queue = this.queue.then(async () => {
      if (!this.rx) {
        if (command !== 'PING') this.log(`${command} dropped — not connected`, 'error');
        return;
      }
      try {
        await this.rx.writeValueWithResponse(encoder.encode(command));
        this.writeFailures = 0;
        this.writeStrikes = 0;
        if (command !== 'PING') this.log(`→ ${command}`); // PING every 2 s would flood the log
      } catch (err) {
        this.log(`→ ${command} failed: ${err.name}: ${err.message}`, 'error');
        this.setStatus({ error: `${command} failed: ${err.message}` });
        this.onWriteFailed();
      }
    });
    return this.queue;
  }

  // RX needs an encrypted link (integration guide §3). Writes that keep
  // failing mean the link is not encrypted: pairing failed or stalled, or the
  // two sides disagree about the bond. First strike: drop the link and
  // reconnect. Second strike: full rescan, and on Windows the main process
  // removes the OS bond and pairs again (win-pair.js).
  onWriteFailed() {
    this.writeFailures += 1;
    if (this.writeFailures < MAX_WRITE_FAILURES || !this.device) return;
    this.writeFailures = 0;
    this.writeStrikes += 1;
    const device = this.device;
    this.rx = null;
    if (this.writeStrikes === 1) {
      this.log(`${MAX_WRITE_FAILURES} writes failed in a row — link not encrypted (pairing failed?); reconnecting`, 'error');
      if (device.gatt.connected) device.gatt.disconnect(); // → gattserverdisconnected → onDisconnected
      else this.onDisconnected();
      return;
    }
    this.log('Writes still failing after reconnect — likely bond mismatch; re-pairing from scratch', 'error');
    this.writeStrikes = 0;
    this.device = null; // before disconnect, so its event doesn't schedule a reconnect too
    device.gatt.disconnect();
    if (!this.autoReconnect) return this.stopRetrying('Writes still failing');
    this.retry(() => this.requestScan({ repair: true }), 1000);
  }

  /** Arms both buttons for a round. */
  arm() {
    this.setPinging(false);
    return this.send('START');
  }

  /** PING only while the game is idle (device is waiting for a game start). */
  setPinging(on) {
    if (on && !this.pingTimer) this.pingTimer = setInterval(() => this.send('PING'), PING_MS);
    if (!on && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
