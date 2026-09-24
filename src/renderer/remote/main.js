// Hidden window: the kiosk's end of the WebRTC link to the admin page.
//
// Signalling goes through public Nostr relays (Trystero), so neither side
// needs a server; the room PIN is Trystero's `password`, which encrypts the
// signalling handshake — peers with a different PIN never connect.
//
// This window is a thin relay: admin messages become the same IPC calls the
// settings window makes, and config/status changes are pushed back.

import { joinRoom } from 'trystero/nostr';
import { REMOTE_ACTIONS as A, REMOTE_PROTOCOL_VERSION } from '../../shared/protocol.js';

const api = window.standoff;
const params = await api.getRemoteParams();
let config = await api.getConfig();
let status = await api.getStatus();
const admins = new Set();

const report = (patch) => api.reportStatus({ remote: { room: params.room || null, admins: admins.size, ...patch } });

function start() {
  if (!params.enabled) return report({ state: 'disabled' });
  if (!params.room) return report({ state: 'no-room', error: 'No room configured (STANDOFF_ROOM or override)' });

  report({ state: 'joining', error: null });
  const room = joinRoom({ appId: params.appId, password: params.pin || undefined }, params.room, {
    onJoinError: (e) => report({ state: 'error', error: e.error }),
  });

  const hello = room.makeAction(A.HELLO);
  const state = room.makeAction(A.STATE);
  const statusAction = room.makeAction(A.STATUS);
  const setConfig = room.makeAction(A.SET_CONFIG);
  const command = room.makeAction(A.COMMAND);
  const result = room.makeAction(A.RESULT);

  const target = () => [...admins];
  const introduce = (peerId) =>
    hello.send(
      { role: 'kiosk', protocol: REMOTE_PROTOCOL_VERSION, name: status.app?.hostname ?? 'kiosk', version: status.app?.version },
      { target: peerId },
    );

  report({ state: 'waiting' });

  room.onPeerJoin = (peerId) => introduce(peerId);
  room.onPeerLeave = (peerId) => {
    admins.delete(peerId);
    report({ state: admins.size ? 'connected' : 'waiting' });
  };

  hello.onMessage = (data, { peerId }) => {
    if (data?.role !== 'admin') return;
    if (data.protocol !== REMOTE_PROTOCOL_VERSION) {
      return result.send({ ok: false, error: `Protocol mismatch: kiosk v${REMOTE_PROTOCOL_VERSION}, admin v${data.protocol}` }, { target: peerId });
    }
    admins.add(peerId);
    report({ state: 'connected' });
    state.send({ config, status }, { target: peerId });
  };

  setConfig.onMessage = async (patch, { peerId }) => {
    if (!admins.has(peerId)) return;
    await api.setConfig(patch); // broadcast back through onConfig below
  };

  command.onMessage = async ({ id, name, args } = {}, { peerId }) => {
    if (!admins.has(peerId)) return;
    try {
      await api.command(name, args);
      result.send({ id, ok: true, name }, { target: peerId });
    } catch (err) {
      result.send({ id, ok: false, name, error: err.message }, { target: peerId });
    }
  };

  api.onConfig((next) => {
    config = next;
    if (admins.size) state.send({ config, status }, { target: target() });
  });

  // Status changes often (BLE, timers); send at most every 500 ms.
  let statusTimer = null;
  api.onStatus((next) => {
    status = next;
    if (!admins.size || statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (admins.size) statusAction.send(status, { target: target() });
    }, 500);
  });
}

// Room / PIN / enabled can change from settings: rejoin with the new values.
api.onConfig(async () => {
  const next = await api.getRemoteParams();
  if (next.enabled !== params.enabled || next.room !== params.room || next.pin !== params.pin) location.reload();
});

start();
