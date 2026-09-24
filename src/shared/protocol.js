// Names shared across process / network boundaries. Changing a value here is
// a protocol change: bump REMOTE_PROTOCOL_VERSION when the admin ↔ kiosk
// message shapes change incompatibly.

export const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set', // (patch) → deep-merged, normalized, persisted, broadcast
  CONFIG_CHANGED: 'config:changed', // main → all windows
  STATUS_GET: 'status:get',
  STATUS_REPORT: 'status:report', // renderer → main, partial status
  STATUS_CHANGED: 'status:changed', // main → all windows
  COMMAND: 'command', // renderer → main (name, args)
  GAME_COMMAND: 'game:command', // main → game window
  BLE_SCAN: 'ble:scan', // game → main: please run requestDevice with a user gesture
  REMOTE_PARAMS: 'remote:params', // remote window → main: { room, pin, appId }
};

// Commands accepted by the main process. `remote: true` means the admin page
// is allowed to trigger it over WebRTC.
export const COMMANDS = {
  'game:reset': { remote: true, label: 'Back to start screen' },
  'ble:reconnect': { remote: true, label: 'Reconnect buzzers' },
  'update:check': { remote: true, label: 'Check for updates' },
  'update:install': { remote: true, label: 'Install update now' },
  'app:restart': { remote: true, label: 'Restart app' },
  'remote:reconnect': { remote: true, label: 'Rejoin admin room' },
  'settings:open': { remote: false },
  'settings:close': { remote: false },
  'app:quit': { remote: false, label: 'Quit app' },
};

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_APP_ID = 'standoff-quiz-kiosk';

// Trystero action names (must be ≤ 12 bytes).
export const REMOTE_ACTIONS = {
  HELLO: 'hello', // both directions: { role: 'kiosk'|'admin', protocol, name?, version? }
  STATE: 'state', // kiosk → admin: { config, status }
  STATUS: 'status', // kiosk → admin: status only (frequent)
  SET_CONFIG: 'setConfig', // admin → kiosk: patch
  COMMAND: 'command', // admin → kiosk: { name, args }
  RESULT: 'result', // kiosk → admin: { ok, name, error? }
};

export const GAME_SCREENS = ['start', 'countdown', 'buzz', 'answer', 'result', 'win'];
