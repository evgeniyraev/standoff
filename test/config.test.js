import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, deepMerge, accentFor } from '../src/shared/defaults.js';
import { parseQuestionRows } from '../src/shared/excel.js';

test('normalizeConfig fills defaults and clamps values', () => {
  const cfg = normalizeConfig({ game: { pointsToWin: 0 }, kiosk: { hiddenCorner: 'middle' }, theme: { colors: { red: 'nope' } } });
  assert.equal(cfg.game.pointsToWin, 1);
  assert.equal(cfg.kiosk.hiddenCorner, 'top-right');
  assert.equal(cfg.theme.colors.red, '#D5225C');
  assert.equal(cfg.questions.length, 5);
});

test('deepMerge merges objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] }), { a: { b: 1, c: 3 }, l: [9] });
});

test('accent colours rotate yellow, green, red, purple, blue', () => {
  const cfg = normalizeConfig({});
  const c = cfg.theme.colors;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => accentFor(cfg, n)), [c.yellow, c.green, c.red, c.purple, c.blue, c.yellow]);
});

test('parseQuestionRows accepts letters, numbers and answer text', () => {
  const { questions, errors } = parseQuestionRows([
    ['Question', 'A', 'B', 'C', 'D', 'Correct'],
    ['Q1', 'a', 'b', 'c', 'd', 'C'],
    ['Q2', 'a', 'b', 'c', 'd', 2],
    ['Q3', 'a', 'b', 'c', 'd', 'd'],
    [],
    ['Q4', 'a', 'b', '', 'd', 'A'],
    ['Q5', 'a', 'b', 'c', 'd', 'X'],
  ]);
  assert.deepEqual(questions.map((q) => q.correct), [2, 1, 3]);
  assert.equal(errors.length, 2);
});

test('parseQuestionFile round-trips an exported workbook', async () => {
  const { parseQuestionFile, questionsToXlsxBlob } = await import('../src/shared/excel.js');
  const { SAMPLE_QUESTIONS } = await import('../src/shared/questions.js');
  const blob = questionsToXlsxBlob(SAMPLE_QUESTIONS);
  const { questions, errors } = await parseQuestionFile(blob);
  assert.equal(errors.length, 0);
  assert.deepEqual(
    questions.map((q) => [q.text, q.answers, q.correct]),
    SAMPLE_QUESTIONS.map((q) => [q.text, q.answers, q.correct]),
  );
});
