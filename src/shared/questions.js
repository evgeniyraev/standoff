// Question helpers and the initial question set (from reference/task.txt).

export const makeId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 12);

export const LETTERS = ['A', 'B', 'C', 'D'];

export const SAMPLE_QUESTIONS = [
  {
    id: 'q-ld-budget',
    text: 'How much Learning & Development budget does each employee get annually?',
    answers: ['€250', '€500', '€850', '€1,000'],
    correct: 3,
  },
  {
    id: 'q-abroad',
    text: 'How many days per year can our employees work abroad?',
    answers: ['10 days', '15 days', '20 days', '25 days'],
    correct: 2,
  },
  {
    id: 'q-eu-project',
    text: 'In 2025, Flutter Bulgaria won a European project worth more than…',
    answers: ['€100,000', '€250,000', '€500,000', '€1 million'],
    correct: 2,
  },
  {
    id: 'q-flexibility',
    text: 'What score did colleagues give to flexibility in the way we work?',
    answers: ['7.9/10', '8.4/10', '8.9/10', '9.5/10'],
    correct: 2,
  },
  {
    id: 'q-remote',
    text: 'What score did colleagues give to remote work when needed?',
    answers: ['8.2/10', '8.8/10', '9.4/10', '10/10'],
    correct: 3,
  },
];

// Accepts "B", "b", "2", 2, or the exact answer text; returns 0..3 or -1.
export function parseCorrect(value, answers) {
  if (value === null || value === undefined) return -1;
  const s = String(value).trim();
  if (/^[a-d]$/i.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
  if (/^[1-4]$/.test(s)) return Number(s) - 1;
  const idx = answers.findIndex((a) => a.trim().toLowerCase() === s.toLowerCase());
  return idx;
}

// Picks questions without repeats; reshuffles when the pool runs out and
// avoids showing the same question twice in a row across the reshuffle.
export class QuestionDeck {
  constructor(questions, random = Math.random) {
    this.questions = questions;
    this.random = random;
    this.pile = [];
    this.last = null;
  }

  shuffle() {
    const pile = [...this.questions];
    for (let i = pile.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [pile[i], pile[j]] = [pile[j], pile[i]];
    }
    if (pile.length > 1 && pile[pile.length - 1] === this.last) {
      [pile[0], pile[pile.length - 1]] = [pile[pile.length - 1], pile[0]];
    }
    this.pile = pile;
  }

  draw() {
    if (!this.questions.length) return null;
    if (!this.pile.length) this.shuffle();
    this.last = this.pile.pop();
    return this.last;
  }
}
