import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/shared/game-engine.js';
import { normalizeConfig } from '../src/shared/defaults.js';

function setup(overrides = {}) {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(nextId, { fn, at: now + ms }), nextId++),
    clearTimeout: (id) => timers.delete(id),
  };
  const advance = (seconds) => {
    const target = now + seconds * 1000;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  const config = normalizeConfig({ game: { countdownSeconds: 3, ...overrides } });
  const effects = [];
  const engine = new GameEngine({
    getConfig: () => config,
    onState: () => {},
    onEffect: (e) => effects.push(e.type),
    clock,
    random: () => 0.5,
  });
  const correct = () => engine.state.question.correct;
  const wrongIdx = () => (engine.state.question.correct + 1) % 4;
  return { engine, advance, effects, correct, wrongIdx };
}

test('countdown then first question arms the buzzers', () => {
  const { engine, advance, effects } = setup();
  engine.ready();
  assert.equal(engine.state.screen, 'countdown');
  advance(3);
  assert.equal(engine.state.screen, 'buzz');
  assert.equal(engine.state.questionNumber, 1);
  assert.deepEqual(effects, ['arm']);
});

test('correct answer scores and first to pointsToWin wins', () => {
  const { engine, advance, correct } = setup({ pointsToWin: 2 });
  engine.ready();
  advance(3);
  engine.buzz(2);
  engine.answer(correct());
  assert.equal(engine.state.screen, 'result');
  assert.deepEqual(engine.state.scores, [0, 1]);
  advance(5);
  assert.equal(engine.state.screen, 'buzz');
  assert.equal(engine.state.questionNumber, 2);
  engine.buzz(2);
  engine.answer(correct());
  assert.equal(engine.state.result.won, true);
  advance(5);
  assert.equal(engine.state.screen, 'win');
  assert.equal(engine.state.winner, 2);
});

test('play again returns to the rules screen with fresh scores', () => {
  const { engine, advance, correct } = setup({ pointsToWin: 1 });
  engine.ready();
  advance(3);
  engine.buzz(1);
  engine.answer(correct());
  advance(5);
  assert.equal(engine.state.screen, 'win');
  engine.ready(); // only the rules screen starts a game
  assert.equal(engine.state.screen, 'win');
  engine.playAgain();
  assert.equal(engine.state.screen, 'start');
  assert.deepEqual(engine.state.scores, [0, 0]);
  engine.ready();
  assert.equal(engine.state.screen, 'countdown');
});

test('wrong answer hands over to the other player once', () => {
  const { engine, advance, wrongIdx } = setup();
  engine.ready();
  advance(3);
  engine.buzz(1);
  engine.answer(wrongIdx());
  assert.equal(engine.state.result.nextPlayer, 2);
  advance(3);
  assert.equal(engine.state.screen, 'answer');
  assert.equal(engine.state.player, 2);
  engine.answer(engine.state.wrong[0]); // already-wrong option is ignored
  assert.equal(engine.state.screen, 'answer');
  advance(10); // player 2 times out
  assert.equal(engine.state.result.kind, 'timeout');
  assert.equal(engine.state.result.nextPlayer, null);
  assert.equal(engine.state.result.closed, true);
  advance(5);
  assert.equal(engine.state.screen, 'buzz');
  assert.deepEqual(engine.state.scores, [0, 0]);
});

test('nobody buzzes → next question; buzz ignored outside buzz screen', () => {
  const { engine, advance } = setup();
  engine.ready();
  assert.equal(engine.buzz(1), false);
  advance(3);
  advance(10);
  assert.equal(engine.state.result.kind, 'nobuzz');
  advance(5);
  assert.equal(engine.state.questionNumber, 2);
});

test('questions reshuffle after the pool is exhausted', () => {
  const { engine, advance } = setup();
  engine.ready();
  advance(3);
  const seen = [];
  for (let i = 0; i < 7; i++) {
    seen.push(engine.state.question.id);
    advance(15);
  }
  assert.equal(new Set(seen.slice(0, 5)).size, 5);
  assert.notEqual(seen[5], seen[4]);
});

test('reset returns to start from anywhere', () => {
  const { engine, advance } = setup();
  engine.ready();
  advance(3);
  engine.buzz(1);
  engine.reset();
  assert.equal(engine.state.screen, 'start');
  advance(60);
  assert.equal(engine.state.screen, 'start');
});
