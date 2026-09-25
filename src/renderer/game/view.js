// Pure HTML templates for each game screen. The stage is a fixed 1080×1920
// canvas (see game.css) scaled to fit the display, so all sizes here are in
// design pixels matching the reference concepts ×1.2.

import { LETTERS } from '../../shared/questions.js';
import { accentFor } from '../../shared/defaults.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad2 = (n) => String(n).padStart(2, '0');

export function remainingSeconds(state, now = Date.now()) {
  if (!state.deadline) return 0;
  return Math.max(0, Math.ceil((state.deadline - now) / 1000));
}

// ---- building blocks ---------------------------------------------------------

const brandHeader = (logo, label) => `
  <header class="brand">
    <img class="logo" src="${esc(logo)}" alt="" draggable="false">
    <span class="eyebrow">${esc(label)}</span>
  </header>`;

const dots = (score, total) =>
  Array.from({ length: total }, (_, i) => `<i class="dot${i < score ? ' on' : ''}"></i>`).join('');

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

function scoreboard(state, cfg, { ringColor, ringLabel, activePlayer }) {
  const player = (n) => `
    <div class="player${activePlayer === n ? ' active' : ''}">
      <span class="player-name">PLAYER ${n}</span>
      <span class="dots">${dots(state.scores[n - 1], cfg.game.pointsToWin)}</span>
    </div>`;
  return `
    <header class="board">
      ${player(1)}
      <div class="ring" style="--ring:${ringColor}">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ring-track" cx="60" cy="60" r="${RING_R}"/>
          <circle class="ring-progress" cx="60" cy="60" r="${RING_R}"
            stroke-dasharray="${RING_C}" stroke-dashoffset="0" data-ring/>
        </svg>
        <span class="ring-label" ${ringLabel === null ? 'data-remaining' : ''}>${ringLabel ?? ''}</span>
      </div>
      ${player(2)}
    </header>`;
}

// ---- screens -----------------------------------------------------------------

function startScreen(state, cfg, logo) {
  const c = cfg.theme.colors;
  const rules = [
    [c.blue, `You have ${cfg.game.buzzSeconds} seconds to press your blue button.`],
    [c.green, 'The first player to press gets to answer.'],
    [c.red, 'Tap A, B, C or D on the screen.'],
    [c.yellow, 'A correct answer wins 1 point.'],
    ...(cfg.game.stealOnWrong ? [[c.purple, 'If your answer is incorrect, your opponent gets a chance.']] : []),
    [c.sky, `First player to score ${cfg.game.pointsToWin} point${cfg.game.pointsToWin === 1 ? '' : 's'} wins!`],
  ];
  return `
    <section class="screen start">
      ${brandHeader(logo, 'GAME RULES')}
      <div class="content">
        <p class="kicker">BEFORE WE BEGIN</p>
        <h1 class="title">HOW TO<br>PLAY</h1>
        <ol class="rules">
          ${rules.map(([color, text], i) => `<li><span class="bullet" style="--c:${color}">${i + 1}</span><span>${esc(text)}</span></li>`).join('')}
        </ol>
        <button class="cta" data-action="ready">WE’RE READY</button>
      </div>
    </section>`;
}

function countdownScreen(state, cfg, logo) {
  return `
    <section class="screen countdown">
      ${brandHeader(logo, 'BOTH PLAYERS AT THE BUTTONS')}
      <div class="content">
        <div class="get-ready">
          <span class="get">GET</span>
          <span class="count">${state.countdown}</span>
          <span class="ready" style="color:${cfg.theme.colors.yellow}">READY</span>
        </div>
        <p class="subtle">THE FIRST QUESTION IS COMING UP</p>
      </div>
    </section>`;
}

function questionBlock(state, cfg, accent, subLabel) {
  return `
    <div class="question" style="--accent:${accent}">
      <div class="qnum">
        <span class="qnum-big">${pad2(state.questionNumber)}</span>
        <span class="qnum-sub">${esc(subLabel)}</span>
      </div>
      <h2 class="qtext">${esc(state.question.text)}</h2>
    </div>`;
}

function answersGrid(state, accent, { interactive, reveal = false }) {
  const q = state.question;
  const picked = state.result?.picked;
  return `
    <div class="answers${interactive ? ' interactive' : ''}" style="--accent:${accent}">
      ${q.answers
        .map((text, i) => {
          const cls = [
            'answer',
            state.wrong?.includes(i) ? 'wrong' : '',
            reveal && i === q.correct ? 'correct' : '',
            picked === i && i === q.correct ? 'picked' : '',
          ].join(' ');
          return `
            <button class="${cls}" data-answer="${i}" ${interactive && !state.wrong?.includes(i) ? '' : 'disabled'}>
              <span class="letter">${LETTERS[i]}</span>
              <span class="answer-text">${esc(text)}</span>
            </button>`;
        })
        .join('')}
    </div>`;
}

function buzzScreen(state, cfg) {
  const accent = accentFor(cfg, state.questionNumber);
  const sub = state.questionNumber <= cfg.game.displayTotal ? `OF ${pad2(cfg.game.displayTotal)}` : '';
  return `
    <section class="screen play">
      ${scoreboard(state, cfg, { ringColor: accent, ringLabel: null })}
      <div class="content">
        ${questionBlock(state, cfg, accent, sub)}
        ${answersGrid(state, accent, { interactive: false })}
        <p class="hint">PRESS YOUR BLUE BUTTON TO ANSWER</p>
      </div>
    </section>`;
}

function answerScreen(state, cfg) {
  const accent = accentFor(cfg, state.questionNumber);
  const steal = state.wrong.length > 0 || state.attempted.length > 1;
  return `
    <section class="screen play answering">
      ${scoreboard(state, cfg, { ringColor: accent, ringLabel: null, activePlayer: state.player })}
      <div class="content">
        ${questionBlock(state, cfg, accent, `PLAYER ${state.player}`)}
        ${answersGrid(state, accent, { interactive: true })}
        <p class="hint">PLAYER ${state.player} · ${steal ? 'YOUR CHANCE · ' : ''}TAP YOUR ANSWER</p>
      </div>
    </section>`;
}

function resultScreen(state, cfg) {
  const c = cfg.theme.colors;
  const r = state.result;
  const q = state.question;
  const next = r.won
    ? 'And that’s the game…'
    : r.nextPlayer
      ? `Player ${r.nextPlayer}, it’s your chance…`
      : `Next question in <span data-remaining>${state.duration}</span>…`;
  const reveal = r.closed && r.kind !== 'correct'
    ? `<p class="reveal">Correct answer: <b>${LETTERS[q.correct]} · ${esc(q.answers[q.correct])}</b></p>`
    : '';
  const variants = {
    correct: { color: c.green, icon: '✓', big: '+1', eyebrow: `PLAYER ${r.player}`, title: 'CORRECT!', line: 'Great answer.' },
    wrong: {
      color: c.red, icon: '✕', big: '✕', eyebrow: `PLAYER ${r.player}`, title: 'WRONG!',
      line: 'Not this time.',
    },
    timeout: {
      color: c.yellow, icon: '0', big: '00', eyebrow: `PLAYER ${r.player}`, title: 'TIME’S UP!',
      line: 'Out of time.',
    },
    nobuzz: { color: c.sky, icon: '0', big: '00', eyebrow: 'NOBODY BUZZED', title: 'TOO SLOW!', line: 'Be quicker on the button.' },
  };
  const v = variants[r.kind];
  return `
    <section class="screen result" style="--accent:${v.color}">
      ${scoreboard(state, cfg, { ringColor: v.color, ringLabel: v.icon, activePlayer: r.nextPlayer ?? r.player })}
      <div class="content">
        <div class="result-big">${v.big}</div>
        <p class="kicker">${esc(v.eyebrow)}</p>
        <h1 class="result-title">${v.title}</h1>
        <p class="result-line">${esc(v.line)}</p>
        ${reveal}
        <p class="result-next">${next}</p>
      </div>
    </section>`;
}

function winScreen(state, cfg, logo) {
  const c = cfg.theme.colors;
  const unit = (n) => (n === 1 ? 'POINT' : 'POINTS');
  return `
    <section class="screen win">
      ${brandHeader(logo, 'CHANGING THE GAME')}
      <div class="content">
        <p class="kicker">WE HAVE A WINNER</p>
        <div class="winner">
          <span class="winner-player">PLAYER</span>
          <span class="winner-wins" style="color:${c.yellow}">${state.winner} WINS!</span>
          <svg class="star" viewBox="0 0 100 95" style="fill:${c.yellow}" aria-hidden="true">
            <polygon points="50,0 61.8,35.3 99,35.3 68.9,57.2 80.3,92.5 50,70.7 19.7,92.5 31.1,57.2 1,35.3 38.2,35.3"/>
          </svg>
        </div>
        <p class="tagline">Fast thinking. Great answers.<br><b>Changing the game!</b></p>
        <div class="final-scores">
          <div><span>PLAYER 1</span><b>${state.scores[0]}</b><span>${unit(state.scores[0])}</span></div>
          <div><span>PLAYER 2</span><b>${state.scores[1]}</b><span>${unit(state.scores[1])}</span></div>
        </div>
        <button class="cta" data-action="again">PLAY AGAIN</button>
        <!-- Future: a "hold for photo" indicator can live here; it should call
             idle.pause('photo') / idle.resume('photo') (see idle.js). -->
      </div>
    </section>`;
}

const SCREENS = {
  start: startScreen,
  countdown: countdownScreen,
  buzz: buzzScreen,
  answer: answerScreen,
  result: resultScreen,
  win: winScreen,
};

export function renderScreen(state, cfg, logo) {
  return SCREENS[state.screen](state, cfg, logo);
}

/** Called ~10×/s to update the live countdown number and ring. */
export function tick(root, state, now = Date.now()) {
  const remaining = remainingSeconds(state, now);
  for (const el of root.querySelectorAll('[data-remaining]')) {
    const text = state.screen === 'result' ? String(remaining) : pad2(remaining);
    if (el.textContent !== text) el.textContent = text;
  }
  const ring = root.querySelector('[data-ring]');
  if (ring) {
    const fraction = state.deadline && state.duration ? Math.max(0, (state.deadline - now) / (state.duration * 1000)) : 1;
    ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - fraction)));
  }
}
