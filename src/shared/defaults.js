// Default configuration and helpers shared by the main process, the kiosk
// renderers and the admin page. Everything that is user-editable lives in the
// config object; see docs/ARCHITECTURE.md → "Configuration".

import { SAMPLE_QUESTIONS } from './questions.js';

export const CONFIG_SCHEMA_VERSION = 1;

// Sampled from reference/colors.jpeg (Flutter brand guidelines).
export const BRAND_COLORS = {
  navy: '#16205B',
  blue: '#0385FF',
  sky: '#CBE5FE',
  darkNavy: '#0C112F',
  green: '#61D37E',
  red: '#D5225C',
  yellow: '#F8CD4B',
  purple: '#895CF5',
};

// Question N uses accentOrder[(N - 1) % accentOrder.length].
export const DEFAULT_ACCENT_ORDER = ['yellow', 'green', 'red', 'purple', 'blue'];

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export const DEFAULT_CONFIG = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  game: {
    pointsToWin: 2,
    buzzSeconds: 10, // time for someone to press a buzzer
    answerSeconds: 10, // time for the buzzing player to tap an answer
    resultSeconds: 5, // "+1 CORRECT! Next question in 5…"
    handoverSeconds: 3, // "Wrong — Player 2, your chance!"
    countdownSeconds: 3, // "GET READY 3…2…1"
    displayTotal: 5, // "01 OF 05" is shown while questionNumber <= displayTotal
    stealOnWrong: true, // the other player gets one chance after a wrong answer
  },
  kiosk: {
    idleTimeoutSeconds: 30, // no touch/buzzer input → back to the start screen
    hiddenCorner: 'top-right',
    hiddenSize: 100,
    holdSeconds: 10, // hold the hidden button → settings
    doubleTapMs: 400, // double tap the hidden button → back to start
  },
  theme: {
    logo: null, // data: URL; null = bundled logo
    colors: { ...BRAND_COLORS },
    accentOrder: [...DEFAULT_ACCENT_ORDER],
  },
  ble: {
    enabled: true,
    keyboardFallback: true, // keys 1 / 2 act as buzzers
  },
  remote: {
    enabled: true,
    roomOverride: '', // empty = room baked in at build time
    pinOverride: '',
  },
  questions: SAMPLE_QUESTIONS,
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep merge where plain objects merge recursively and everything else
// (arrays, primitives, null) replaces. Used both for "defaults ⊕ stored" and
// for applying partial patches coming from the settings UI or the admin.
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Returns a config that is safe to use no matter what was stored or received.
export function normalizeConfig(raw) {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), isPlainObject(raw) ? raw : {});
  const d = DEFAULT_CONFIG;
  const g = cfg.game;
  g.pointsToWin = clampInt(g.pointsToWin, 1, 20, d.game.pointsToWin);
  g.buzzSeconds = clampInt(g.buzzSeconds, 3, 120, d.game.buzzSeconds);
  g.answerSeconds = clampInt(g.answerSeconds, 3, 120, d.game.answerSeconds);
  g.resultSeconds = clampInt(g.resultSeconds, 1, 60, d.game.resultSeconds);
  g.handoverSeconds = clampInt(g.handoverSeconds, 1, 30, d.game.handoverSeconds);
  g.countdownSeconds = clampInt(g.countdownSeconds, 0, 10, d.game.countdownSeconds);
  g.displayTotal = clampInt(g.displayTotal, 0, 99, d.game.displayTotal);
  g.stealOnWrong = Boolean(g.stealOnWrong);

  const k = cfg.kiosk;
  k.idleTimeoutSeconds = clampInt(k.idleTimeoutSeconds, 5, 3600, d.kiosk.idleTimeoutSeconds);
  if (!CORNERS.includes(k.hiddenCorner)) k.hiddenCorner = d.kiosk.hiddenCorner;
  k.hiddenSize = clampInt(k.hiddenSize, 40, 400, d.kiosk.hiddenSize);
  k.holdSeconds = clampInt(k.holdSeconds, 2, 60, d.kiosk.holdSeconds);
  k.doubleTapMs = clampInt(k.doubleTapMs, 150, 1500, d.kiosk.doubleTapMs);

  const t = cfg.theme;
  for (const key of Object.keys(BRAND_COLORS)) {
    if (!/^#[0-9a-f]{6}$/i.test(t.colors[key] ?? '')) t.colors[key] = BRAND_COLORS[key];
  }
  t.accentOrder = (Array.isArray(t.accentOrder) ? t.accentOrder : []).filter((c) => c in BRAND_COLORS);
  if (!t.accentOrder.length) t.accentOrder = [...DEFAULT_ACCENT_ORDER];
  if (typeof t.logo !== 'string' || !t.logo.startsWith('data:image/')) t.logo = null;

  cfg.questions = (Array.isArray(cfg.questions) ? cfg.questions : []).filter(isValidQuestion);
  cfg.schemaVersion = CONFIG_SCHEMA_VERSION;
  return cfg;
}

export function isValidQuestion(q) {
  return (
    isPlainObject(q) &&
    typeof q.text === 'string' &&
    q.text.trim() !== '' &&
    Array.isArray(q.answers) &&
    q.answers.length === 4 &&
    q.answers.every((a) => typeof a === 'string' && a.trim() !== '') &&
    Number.isInteger(q.correct) &&
    q.correct >= 0 &&
    q.correct < 4
  );
}

export function accentFor(config, questionNumber) {
  const order = config.theme.accentOrder;
  const name = order[(Math.max(1, questionNumber) - 1) % order.length];
  return config.theme.colors[name];
}
