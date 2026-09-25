// Game window bootstrap: wires the engine, the view, the buzzers, the idle
// watchdog and the hidden operator button together.

import '../browser-shim.js';
import '../../assets/fonts.css';
import './game.css';
import defaultLogo from '../../assets/logo-white.png';
import { GameEngine } from '../../shared/game-engine.js';
import { renderScreen, tick } from './view.js';
import { Buzzers } from './ble.js';
import { IdleWatchdog } from './idle.js';
import { mountHiddenButton } from './hidden-button.js';

const api = window.standoff;
const stage = document.getElementById('stage');
const root = document.documentElement;

let config = await api.getConfig();

// ---- stage scaling: 1080×1920 design canvas fitted to any display ------------

function fitStage() {
  const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  root.style.setProperty('--scale', String(scale));
}
window.addEventListener('resize', fitStage);
fitStage();

// ---- theme ------------------------------------------------------------------

const cssVar = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
function applyTheme() {
  for (const [name, value] of Object.entries(config.theme.colors)) root.style.setProperty(`--${cssVar(name)}`, value);
}

// ---- engine + rendering -----------------------------------------------------

const engine = new GameEngine({
  getConfig: () => config,
  onState: (state) => onState(state),
  onEffect: (effect) => {
    if (effect.type === 'arm') buzzers.arm();
    if (effect.type === 'disarm') buzzers.disarm();
  },
});

function render() {
  const state = engine.state;
  stage.innerHTML = renderScreen(state, config, config.theme.logo ?? defaultLogo);
  stage.dataset.screen = state.screen;
  stage.dataset.bg = state.screen === 'buzz' || state.screen === 'answer' ? (state.questionNumber % 2 ? '1' : '2') : '1';
  tick(stage, state);
}

function onState(state) {
  render();
  idle.setActive(state.screen !== 'start');
  buzzers.setPinging(state.screen === 'start' || state.screen === 'win');
  api.reportStatus({
    game: {
      screen: state.screen,
      scores: state.scores,
      questionNumber: state.questionNumber,
      player: state.player ?? null,
      questionId: state.question?.id ?? null,
    },
  });
}

setInterval(() => tick(stage, engine.state), 100);

stage.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action], [data-answer]');
  if (!target || target.disabled) return;
  if (target.dataset.answer !== undefined) engine.answer(Number(target.dataset.answer));
  else if (target.dataset.action === 'ready') engine.ready();
  else if (target.dataset.action === 'again') engine.playAgain();
});

// ---- buzzers ------------------------------------------------------------------

const buzzers = new Buzzers({
  onButton: (player) => {
    idle.poke();
    engine.buzz(player);
  },
  onStatus: (s) => {
    api.reportStatus({ ble: s });
    document.getElementById('ble-dot').dataset.state = s.state;
  },
});

window.addEventListener('keydown', (e) => {
  if (!config.ble.keyboardFallback || e.repeat) return;
  if (e.key === '1' || e.key === '2') {
    idle.poke();
    engine.buzz(Number(e.key));
  }
});

// ---- idle fallback + hidden button -----------------------------------------

const idle = new IdleWatchdog(() => engine.reset());
window.addEventListener('pointerdown', () => idle.poke(), { capture: true });

const hidden = mountHiddenButton(document.getElementById('hidden-button'), {
  onDoubleTap: () => engine.reset(),
  onHold: () => api.command('settings:open'),
});

// Block long-press context menus, text selection and pinch-zoom on the kiosk.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- config + commands from main --------------------------------------------

function applyConfig() {
  applyTheme();
  idle.configure(config.kiosk.idleTimeoutSeconds);
  hidden.configure(config.kiosk);
  buzzers.setAutoReconnect(config.ble.autoReconnect);
  buzzers.setEnabled(config.ble.enabled);
  render();
}

api.onConfig((next) => {
  config = next;
  applyConfig();
});

api.onGameCommand((payload) => {
  const { name } = payload;
  if (name === 'reset') engine.reset();
  if (name === 'ble:reconnect') buzzers.reconnect();
  if (name === 'ble:unavailable') {
    buzzers.log(payload.reason, 'error');
    buzzers.setStatus({ state: 'unsupported', error: payload.reason });
  }
  if (name === 'ble:log') buzzers.log(`[main] ${payload.msg}`, payload.level);
});

applyConfig();
onState(engine.state);

// Handle for DevTools / automated checks.
window.__standoffDebug = { engine, idle, buzzers };
