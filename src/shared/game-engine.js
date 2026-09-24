// The game rules as a small state machine with no DOM or hardware access.
// The game window feeds it events (tap Ready, buzzer press, answer tap) and
// renders whatever state it emits. Timers are injected so tests can drive
// time deterministically.
//
// Screens:  start → countdown → buzz ⇄ answer → result → (buzz | answer | win)
//
//   start      "How to play" + WE'RE READY
//   countdown  GET READY 3…2…1
//   buzz       question shown, buzzers armed, buzzSeconds to press
//   answer     one player answers by tapping, answerSeconds
//   result     correct | wrong | timeout | nobuzz, then continue
//   win        winner screen until PLAY AGAIN or idle reset

import { QuestionDeck } from './questions.js';

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class GameEngine {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig  current normalized config
   * @param {(state: object) => void} opts.onState  called after every change
   * @param {(effect: {type: string}) => void} [opts.onEffect]  side effects, e.g. { type: 'arm' }
   */
  constructor({ getConfig, onState, onEffect = () => {}, clock = defaultClock, random = Math.random }) {
    this.getConfig = getConfig;
    this.onState = onState;
    this.onEffect = onEffect;
    this.clock = clock;
    this.random = random;
    this.timer = null;
    this.deck = null;
    this.state = { screen: 'start', scores: [0, 0], questionNumber: 0 };
  }

  // ---- public events -----------------------------------------------------

  /** WE'RE READY / PLAY AGAIN */
  ready() {
    if (this.state.screen !== 'start' && this.state.screen !== 'win') return;
    const cfg = this.getConfig();
    this.deck = new QuestionDeck(cfg.questions, this.random);
    this.set({ screen: 'countdown', scores: [0, 0], questionNumber: 0, winner: null, question: null });
    this.runCountdown(cfg.game.countdownSeconds);
  }

  /** A physical buzzer (player = 1 | 2). */
  buzz(player) {
    if (this.state.screen !== 'buzz' || (player !== 1 && player !== 2)) return false;
    this.startAnswer(player, []);
    return true;
  }

  /** The answering player tapped option `index` (0..3). */
  answer(index) {
    const s = this.state;
    if (s.screen !== 'answer' || s.wrong.includes(index)) return;
    if (index === s.question.correct) {
      const scores = [...s.scores];
      scores[s.player - 1] += 1;
      this.showResult({ kind: 'correct', player: s.player, picked: index, scores });
    } else {
      this.afterMiss('wrong', index);
    }
  }

  /** Back to the start screen (idle fallback, double tap, admin). */
  reset() {
    this.clearTimer();
    this.set({ screen: 'start', scores: [0, 0], questionNumber: 0, question: null, winner: null, deadline: null });
  }

  destroy() {
    this.clearTimer();
  }

  // ---- internals -----------------------------------------------------------

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  clearTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  after(seconds, fn) {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      fn();
    }, seconds * 1000);
  }

  deadlineIn(seconds) {
    return this.clock.now() + seconds * 1000;
  }

  runCountdown(seconds) {
    if (seconds <= 0) return this.nextQuestion();
    this.set({ screen: 'countdown', countdown: seconds });
    this.after(1, () => this.runCountdown(seconds - 1));
  }

  nextQuestion() {
    const cfg = this.getConfig();
    const question = this.deck.draw();
    if (!question) return this.reset(); // no questions configured
    const questionNumber = this.state.questionNumber + 1;
    this.set({
      screen: 'buzz',
      question,
      questionNumber,
      player: null,
      wrong: [],
      attempted: [],
      result: null,
      deadline: this.deadlineIn(cfg.game.buzzSeconds),
      duration: cfg.game.buzzSeconds,
    });
    this.onEffect({ type: 'arm' });
    this.after(cfg.game.buzzSeconds, () => this.showResult({ kind: 'nobuzz' }));
  }

  startAnswer(player, wrongSoFar) {
    const cfg = this.getConfig();
    this.set({
      screen: 'answer',
      player,
      wrong: wrongSoFar,
      attempted: [...(this.state.attempted ?? []), player],
      deadline: this.deadlineIn(cfg.game.answerSeconds),
      duration: cfg.game.answerSeconds,
    });
    this.after(cfg.game.answerSeconds, () => this.afterMiss('timeout', null));
  }

  afterMiss(kind, pickedIndex) {
    const cfg = this.getConfig();
    const s = this.state;
    const wrong = pickedIndex === null ? s.wrong : [...s.wrong, pickedIndex];
    const other = s.player === 1 ? 2 : 1;
    const canSteal = cfg.game.stealOnWrong && !s.attempted.includes(other);
    this.showResult({ kind, player: s.player, picked: pickedIndex, wrong, nextPlayer: canSteal ? other : null });
  }

  showResult({ kind, player = null, picked = null, wrong = this.state.wrong ?? [], nextPlayer = null, scores = this.state.scores }) {
    const cfg = this.getConfig();
    const won = kind === 'correct' && scores[player - 1] >= cfg.game.pointsToWin;
    // The question is "closed" when nobody else will answer it → reveal it.
    const closed = kind === 'correct' || nextPlayer === null;
    const seconds = nextPlayer ? cfg.game.handoverSeconds : cfg.game.resultSeconds;
    this.set({
      screen: 'result',
      result: { kind, player, picked, nextPlayer, closed, won },
      wrong,
      scores,
      deadline: this.deadlineIn(seconds),
      duration: seconds,
    });
    this.after(seconds, () => {
      if (won) this.set({ screen: 'win', winner: player, deadline: null });
      else if (nextPlayer) this.startAnswer(nextPlayer, wrong);
      else this.nextQuestion();
    });
  }
}
