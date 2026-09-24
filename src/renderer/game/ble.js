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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Buzzers {
  constructor({ onButton, onStatus }) {
    this.onButton = onButton;
    this.onStatus = onStatus;
    this.enabled = false;
    this.device = null;
    this.rx = null;
    this.lastSeq = null;
    this.failures = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.status = { state: 'idle', device: null, error: null, deviceState: null };
    this.queue = Promise.resolve(); // GATT writes must not overlap
    window.__standoffBleScan = () => this.scan();
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.requestScan();
    else {
      clearTimeout(this.retryTimer);
      this.device?.gatt?.disconnect();
      this.setStatus({ state: 'disabled' });
    }
  }

  requestScan() {
    if (!this.enabled) return;
    if (!navigator.bluetooth) return this.setStatus({ state: 'unsupported', error: 'Web Bluetooth not available' });
    this.setStatus({ state: 'scanning', error: null });
    window.standoff.bleScan(); // main process calls this.scan() with a user gesture
  }

  async scan() {
    try {
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SERVICE] }] });
      if (this.device !== device) {
        this.device = device;
        device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
      }
      this.failures = 0;
      await this.connect();
    } catch (err) {
      this.setStatus({ state: 'not-found', error: err.message });
      this.retry(() => this.requestScan(), RESCAN_MS);
    }
  }

  async connect() {
    if (!this.device) return this.requestScan();
    this.setStatus({ state: 'connecting', device: this.device.name || this.device.id });
    try {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      this.rx = await service.getCharacteristic(NUS_RX);
      const tx = await service.getCharacteristic(NUS_TX);
      // Re-subscribe on every connection: CCCD state is not guaranteed to survive.
      tx.addEventListener('characteristicvaluechanged', (e) => this.onMessage(decoder.decode(e.target.value)));
      await tx.startNotifications();
      this.failures = 0;
      this.setStatus({ state: 'connected', error: null });
    } catch (err) {
      // Connected-then-rejected on the encrypted op is the bond-mismatch
      // signature (see integration guide §3).
      this.rx = null;
      this.setStatus({ state: 'error', error: err.message });
      this.onDisconnected();
    }
  }

  onDisconnected() {
    this.rx = null;
    if (!this.enabled) return;
    this.failures += 1;
    if (this.failures > MAX_RECONNECTS) {
      this.device = null; // stale handle → full rescan
      this.failures = 0;
      return this.retry(() => this.requestScan(), RESCAN_MS);
    }
    this.setStatus({ state: 'reconnecting' });
    this.retry(() => this.connect(), Math.min(10_000, 1000 * this.failures));
  }

  retry(fn, ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(fn, ms);
  }

  reconnect() {
    this.failures = 0;
    this.device?.gatt?.disconnect();
    this.device = null;
    this.requestScan();
  }

  onMessage(raw) {
    const msg = raw.trim();
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
      if (!this.rx) return;
      try {
        await this.rx.writeValueWithResponse(encoder.encode(command));
      } catch (err) {
        this.setStatus({ error: `${command} failed: ${err.message}` });
      }
    });
    return this.queue;
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
