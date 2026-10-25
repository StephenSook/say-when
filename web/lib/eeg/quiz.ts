/**
 * The true or false practice quiz on /eeg. Pure, so it is tested without React or a headset.
 *
 * TRUE is YES (imagine squeezing the right fist) and FALSE is NO (the left fist), the D11 map. Each question waits
 * one second before it counts an answer (so the end of the last one cannot spill over), then up to ten seconds for
 * a YES or NO from the decoder. The result shows for two seconds, then the next question comes up.
 */
export interface Question {
  text: string;
  answer: boolean;
}

export const QUIZ_TIMING = { graceMs: 1_000, answerMs: 10_000, resultMs: 2_000 } as const;

/** Very plain questions on purpose: the person should know the answer at once and spend the time on the squeeze. */
export const QUESTIONS: readonly Question[] = [
  { text: 'The sky is blue on a clear day.', answer: true },
  { text: 'Grass is green.', answer: true },
  { text: 'Snow is white.', answer: true },
  { text: 'Dogs can bark.', answer: true },
  { text: 'Fish live in water.', answer: true },
  { text: 'Birds have wings.', answer: true },
  { text: '1 + 1 equals 2.', answer: true },
  { text: '10 is bigger than 5.', answer: true },
  { text: 'A week has seven days.', answer: true },
  { text: 'People have two eyes.', answer: true },
  { text: 'Fire is hot.', answer: true },
  { text: 'Ice is cold.', answer: true },
  { text: 'A square has four sides.', answer: true },
  { text: 'The sun rises in the morning.', answer: true },
  { text: 'Ripe bananas are yellow.', answer: true },
  { text: 'Grass is purple.', answer: false },
  { text: 'Snow is black.', answer: false },
  { text: 'Cats can fly.', answer: false },
  { text: 'Cows can talk.', answer: false },
  { text: 'Fish can climb trees.', answer: false },
  { text: '1 + 1 equals 5.', answer: false },
  { text: '3 is bigger than 9.', answer: false },
  { text: 'A week has ten days.', answer: false },
  { text: 'People have three eyes.', answer: false },
  { text: 'Ice is hot.', answer: false },
  { text: 'Water is dry.', answer: false },
  { text: 'A circle has four corners.', answer: false },
  { text: 'The sun is cold.', answer: false },
  { text: 'Dogs have six legs.', answer: false },
  { text: 'Apples grow on the moon.', answer: false },
];

export interface QuizResult {
  question: Question;
  /** What was read: true (YES), false (NO) or null (no answer in time). */
  said: boolean | null;
  correct: boolean;
  confidence: number | null;
  ms: number;
}

export type QuizPhase = 'idle' | 'asking' | 'result' | 'done';

export interface QuizState {
  questions: Question[];
  index: number;
  phase: QuizPhase;
  askedAt: number;
  shownAt: number;
  results: QuizResult[];
}

export const idleQuiz = (): QuizState => ({ questions: [], index: 0, phase: 'idle', askedAt: 0, shownAt: 0, results: [] });

/** n questions, half true and half false (an odd one goes to a random side), never three alike in a row. */
export function pickQuestions(n: number, random: () => number = Math.random): Question[] {
  const shuffle = <T>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const yes = shuffle(QUESTIONS.filter((q) => q.answer));
  const no = shuffle(QUESTIONS.filter((q) => !q.answer));
  const count = Math.max(1, Math.min(n, yes.length + no.length));
  const nYes = Math.min(yes.length, Math.floor(count / 2) + (count % 2 === 1 && random() < 0.5 ? 1 : 0));
  let picked = [...yes.slice(0, nYes), ...no.slice(0, count - nYes)];
  for (let tries = 0; tries < 1_000; tries += 1) {
    picked = shuffle(picked);
    const ok = picked.every((_, i) => i < 2 || !(picked[i].answer === picked[i - 1].answer && picked[i].answer === picked[i - 2].answer));
    if (ok) break;
  }
  return picked;
}

export function startQuiz(questions: Question[], now: number): QuizState {
  return { questions, index: 0, phase: questions.length ? 'asking' : 'done', askedAt: now, shownAt: 0, results: [] };
}

/** A YES or NO from the decoder. Anything else, or anything during the first second, is ignored. */
export function onCommand(state: QuizState, command: string, confidence: number, now: number): QuizState {
  if (state.phase !== 'asking' || now - state.askedAt < QUIZ_TIMING.graceMs) return state;
  if (command !== 'YES' && command !== 'NO') return state;
  const question = state.questions[state.index];
  const said = command === 'YES';
  const result: QuizResult = { question, said, correct: said === question.answer, confidence, ms: now - state.askedAt };
  return { ...state, phase: 'result', shownAt: now, results: [...state.results, result] };
}

/** Moves time on: a question that ran out counts as no answer; a shown result gives way to the next question. */
export function tick(state: QuizState, now: number): QuizState {
  if (state.phase === 'asking' && now - state.askedAt >= QUIZ_TIMING.graceMs + QUIZ_TIMING.answerMs) {
    const question = state.questions[state.index];
    const result: QuizResult = { question, said: null, correct: false, confidence: null, ms: now - state.askedAt };
    return { ...state, phase: 'result', shownAt: now, results: [...state.results, result] };
  }
  if (state.phase === 'result' && now - state.shownAt >= QUIZ_TIMING.resultMs) {
    const next = state.index + 1;
    return next >= state.questions.length
      ? { ...state, phase: 'done' }
      : { ...state, index: next, phase: 'asking', askedAt: now };
  }
  return state;
}

/** Seconds left to answer, or null outside a question. */
export function secondsLeft(state: QuizState, now: number): number | null {
  if (state.phase !== 'asking') return null;
  return Math.max(0, Math.ceil((QUIZ_TIMING.graceMs + QUIZ_TIMING.answerMs - (now - state.askedAt)) / 1_000));
}

export function score(state: QuizState): { right: number; asked: number; answered: number } {
  return {
    right: state.results.filter((r) => r.correct).length,
    asked: state.results.length,
    answered: state.results.filter((r) => r.said !== null).length,
  };
}
