// When a renderer page is opened in a plain browser (e.g. `npx vite` and
// http://localhost:5173/game/), there is no Electron preload. This installs an
// in-memory stand-in for window.standoff so screens can be designed and
// tested in any browser. Tabs share state through BroadcastChannel, so the
// settings page in one tab drives the game in another. Never used in the app.

import { deepMerge, normalizeConfig } from '../shared/defaults.js';

if (!window.standoff) {
  const channel = new BroadcastChannel('standoff-dev');
  const listeners = { config: new Set(), status: new Set(), game: new Set() };
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem('standoff-dev-config'));
    } catch {
      return null;
    }
  };
  let config = normalizeConfig(load());
  let status = { app: { version: 'browser', hostname: 'browser' }, game: {}, ble: { state: 'disabled' }, update: { state: 'disabled' }, remote: { state: 'disabled' } };
  const emit = (kind, value) => listeners[kind].forEach((cb) => cb(value));

  channel.onmessage = ({ data }) => {
    if (data.kind === 'config') config = data.value;
    if (data.kind === 'status') status = data.value;
    emit(data.kind, data.value);
  };
  const publish = (kind, value) => {
    emit(kind, value);
    channel.postMessage({ kind, value });
  };
  const subscribe = (set) => (cb) => (set.add(cb), () => set.delete(cb));

  window.standoff = {
    getConfig: async () => config,
    async setConfig(patch) {
      config = normalizeConfig(deepMerge(config, patch));
      try {
        localStorage.setItem('standoff-dev-config', JSON.stringify(config));
      } catch {}
      publish('config', config);
      return config;
    },
    onConfig: subscribe(listeners.config),
    getStatus: async () => status,
    reportStatus(partial) {
      for (const [k, v] of Object.entries(partial)) status = { ...status, [k]: { ...status[k], ...v } };
      publish('status', status);
    },
    onStatus: subscribe(listeners.status),
    async command(name) {
      if (name === 'game:reset') publish('game', { name: 'reset' });
      else if (name === 'settings:open') window.open('../settings/index.html', 'standoff-settings');
      else if (name === 'settings:close') window.close();
      else console.info('[browser-shim] command', name);
      return { ok: true };
    },
    onGameCommand: subscribe(listeners.game),
    bleScan() {},
    getRemoteParams: async () => ({ enabled: false }),
  };
}
