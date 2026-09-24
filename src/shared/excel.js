// Excel / CSV → questions. Used by the settings window and the admin page
// (both run in a browser context, so parsing happens client-side).
//
// Expected sheet layout (first sheet, header row optional):
//   Question | A | B | C | D | Correct
// "Correct" may be a letter (A–D), a number (1–4) or the exact answer text.

import { read, utils, write } from 'xlsx';
import { makeId, parseCorrect } from './questions.js';

export function parseQuestionRows(rows) {
  const questions = [];
  const errors = [];
  rows.forEach((row, i) => {
    const cells = (row ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
    if (cells.every((c) => c === '')) return;
    if (i === 0 && /question|въпрос/i.test(cells[0])) return; // header row
    const [text, a, b, c, d, correctRaw] = cells;
    const answers = [a, b, c, d];
    if (!text || answers.some((x) => !x)) {
      errors.push(`Row ${i + 1}: needs a question and four answers`);
      return;
    }
    const correct = parseCorrect(correctRaw, answers);
    if (correct < 0) {
      errors.push(`Row ${i + 1}: "Correct" must be A–D, 1–4 or the answer text (got "${correctRaw ?? ''}")`);
      return;
    }
    questions.push({ id: makeId(), text, answers, correct });
  });
  return { questions, errors };
}

export async function parseQuestionFile(file) {
  const buffer = await file.arrayBuffer();
  const wb = read(buffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { questions: [], errors: ['The file has no sheets'] };
  const rows = utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false });
  return parseQuestionRows(rows);
}

// Exports the current questions in the same layout the importer accepts, so
// operators can round-trip: export → edit in Excel → drop back in.
export function questionsToXlsxBlob(questions) {
  const rows = [['Question', 'A', 'B', 'C', 'D', 'Correct']];
  for (const q of questions) rows.push([q.text, ...q.answers, 'ABCD'[q.correct]]);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), 'Questions');
  const data = write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
