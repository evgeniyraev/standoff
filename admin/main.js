// Admin page (published to GitHub Pages). Joins the kiosk's Trystero room and
// mounts the same settings UI the kiosk uses, backed by a WebRTC transport.

import './admin.css';
import { joinRoom } from 'trystero/nostr';
import { mountSettings } from '../src/shared/settings-ui/settings-ui.js';
import { deepMerge, normalizeConfig } from '../src/shared/defaults.js';
import { REMOTE_ACTIONS as A, REMOTE_APP_ID, REMOTE_PROTOCOL_VERSION } from '../src/shared/protocol.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ---- connect form -----------------------------------------------------------

const hash = new URLSearchParams(location.hash.slice(1));
$('room').value = hash.get('room') ?? store.get('standoff.room');
$('pin').value = hash.get('pin') ?? '';
if (location.hash) history.replaceState(null, '', location.pathname); // keep secrets out of history

function randomId(bytes) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => alphabet[b % alphabet.length]).join('');
}

$('generate').addEventListener('click', () => {
  const room = `standoff-${randomId(24)}`;
  const pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  $('room').value = room;
  $('pin').value = pin;
  const box = $('generated');
  box.hidden = false;
  box.innerHTML = `
    <strong>New room generated.</strong> Point a kiosk at it in one of two ways:
    <ol>
      <li>Permanently, for new builds: in GitHub → Settings → Secrets and variables → Actions,
        set the variable <code>STANDOFF_ROOM</code> and the secret <code>STANDOFF_PIN</code>, then publish a release.</li>
      <li>Right away: join the kiosk's current room, open <em>System → Admin link</em> and enter these values as the room/PIN override.</li>
    </ol>
    <p>Room: <code></code><br>PIN: <code></code></p>`;
  const codes = box.querySelectorAll('p code');
  codes[0].textContent = room;
  codes[1].textContent = pin;
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = $('room').value.trim();
  store.set('standoff.room', room);
  connect(room, $('pin').value.trim());
});

// ---- session ------------------------------------------------------------------

function connect(roomId, pin) {
  $('connect').hidden = true;
  $('session').hidden = false;
  const setState = (text) => ($('session-state').textContent = text);
  setState('Looking for the kiosk… (can take up to 30 s)');

  const room = joinRoom({ appId: REMOTE_APP_ID, password: pin || undefined }, roomId, {
    onJoinError: (e) => setState(`Could not join: ${e.error} — check the PIN`),
  });
  const hello = room.makeAction(A.HELLO);
  const stateAction = room.makeAction(A.STATE);
  const statusAction = room.makeAction(A.STATUS);
  const setConfigAction = room.makeAction(A.SET_CONFIG);
  const commandAction = room.makeAction(A.COMMAND);
  const resultAction = room.makeAction(A.RESULT);

  const kiosks = new Map(); // peerId → { name, version, config, status }
  let active = null;
  let unmount = null;
  const listeners = { config: new Set(), status: new Set() };
  const pending = new Map(); // command id → { resolve, reject }

  const select = $('kiosk-select');
  function renderKioskSelect() {
    select.hidden = kiosks.size < 2;
    select.replaceChildren(
      ...[...kiosks].map(([id, k]) => Object.assign(document.createElement('option'), { value: id, selected: id === active, textContent: `${k.name} · v${k.version}` })),
    );
  }
  select.addEventListener('change', () => activate(select.value));

  room.onPeerJoin = (peerId) => hello.send({ role: 'admin', protocol: REMOTE_PROTOCOL_VERSION }, { target: peerId });
  room.onPeerLeave = (peerId) => {
    if (!kiosks.delete(peerId)) return;
    renderKioskSelect();
    if (peerId === active) {
      active = null;
      setState('Kiosk disconnected — waiting for it to come back…');
      const next = kiosks.keys().next().value;
      if (next) activate(next);
    }
  };

  hello.onMessage = (data, { peerId }) => {
    if (data?.role !== 'kiosk') return;
    kiosks.set(peerId, { name: data.name, version: data.version, config: null, status: null });
    if (data.protocol !== REMOTE_PROTOCOL_VERSION) setState(`Kiosk ${data.name} speaks protocol v${data.protocol}; this page is v${REMOTE_PROTOCOL_VERSION}. Update one of them.`);
    renderKioskSelect();
    hello.send({ role: 'admin', protocol: REMOTE_PROTOCOL_VERSION }, { target: peerId });
  };

  stateAction.onMessage = ({ config, status }, { peerId }) => {
    const k = kiosks.get(peerId);
    if (!k) return;
    k.config = config;
    k.status = status;
    if (!active) activate(peerId);
    else if (peerId === active) {
      listeners.config.forEach((cb) => cb(config));
      listeners.status.forEach((cb) => cb(status));
    }
  };

  statusAction.onMessage = (status, { peerId }) => {
    const k = kiosks.get(peerId);
    if (!k) return;
    k.status = status;
    if (peerId === active) listeners.status.forEach((cb) => cb(status));
  };

  resultAction.onMessage = ({ id, ok, error }) => {
    const p = pending.get(id);
    if (!p) {
      if (!ok && error) setState(error);
      return;
    }
    pending.delete(id);
    ok ? p.resolve() : p.reject(new Error(error));
  };

  const subscribe = (set) => (cb) => (set.add(cb), () => set.delete(cb));

  // Transport consumed by mountSettings (same shape as window.standoff).
  const api = {
    local: false,
    getConfig: async () => kiosks.get(active).config,
    getStatus: async () => kiosks.get(active).status,
    onConfig: subscribe(listeners.config),
    onStatus: subscribe(listeners.status),
    async setConfig(patch) {
      const k = kiosks.get(active);
      if (!k) throw new Error('Kiosk not connected');
      await setConfigAction.send(patch, { target: active });
      k.config = normalizeConfig(deepMerge(k.config, patch)); // optimistic; kiosk echoes the real one
      return k.config;
    },
    command(name, args) {
      if (!active) return Promise.reject(new Error('Kiosk not connected'));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        commandAction.send({ id, name, args }, { target: active });
        setTimeout(() => pending.delete(id) && reject(new Error('Kiosk did not answer')), 15_000);
      });
    },
  };

  async function activate(peerId) {
    const k = kiosks.get(peerId);
    if (!k?.config) return;
    active = peerId;
    renderKioskSelect();
    setState(`Connected to ${k.name} · v${k.version}`);
    unmount?.();
    unmount = await mountSettings($('settings'), api, { title: `Kiosk: ${k.name}` });
  }

  $('leave').onclick = async () => {
    unmount?.();
    await room.leave();
    location.reload();
  };
}
