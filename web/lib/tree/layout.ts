/**
 * The fixed layout of the Suggested replies tree (Screen 2). Pure, no React.
 *
 * Every position is a hand-placed table entry or a pure slot function of (region, index), never a layout pass over
 * the nodes that exist, so a node that appears later never moves a node already on screen. Units are React Flow
 * canvas units; the screen fits the camera to these rectangles.
 *
 * Read left to right, one round per pick:
 *
 *   question  |  saved notes (hub + 3 slots)  |  drafting  |  options 1 to 4  |  what happened after the pick
 *             |  web facts   (hub + 3 slots)  |            |                  |
 *
 * A follow-up round (an errand, a call, or nothing else, offered after a pick) repeats the last three columns
 * `ROUND_SPAN` to the right, so round 2 starts after round 1's outcome column.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The regions whose children fill fixed slots under their hub. */
export type SlotRegion = 'notes' | 'web';

/** The horizontal line the question, the drafting hubs and the round ends sit on. */
export const SPINE_Y = 380;

/** The height of the whole first round, both regions included. */
export const TREE_HEIGHT = 760;

export const SIZE = {
  question: { width: 340, height: 230 },
  region: { width: 460, height: 372 },
  hub: { width: 428, height: 104 },
  child: { width: 400, height: 74 },
  draft: { width: 380, height: 156 },
  option: { width: 500, height: 176 },
  step: { width: 420, height: 164 },
} as const;

/** Child slots per region. More results fold into the last slot as "+N more". */
export const CHILD_SLOTS = 3;
/** Options per round (the module drafts up to four). */
export const OPTION_SLOTS = 4;
/** Steps after a pick: read back, confirm window, the result. */
export const STEP_SLOTS = 3;
/** How far right each follow-up round starts. */
export const ROUND_SPAN = 1500;

const QUESTION_X = 0;
const REGION_X = 380;
const HUB_INSET = 16;
const CHILD_INSET = 44;
const HUB_TO_CHILD = 10;
const CHILD_GAP = 8;
const DRAFT_X = 890;
const OPTION_OFFSET = 440;
const OPTION_GAP = 12;
const OUTCOME_OFFSET = 580;
const STEP_GAP = 16;

const REGION_TOP: Readonly<Record<SlotRegion, number>> = { notes: 0, web: 388 };

function rect(x: number, y: number, size: { width: number; height: number }): Rect {
  return { x, y, width: size.width, height: size.height };
}

/** The question at the far left, centered on the spine. */
export function questionRect(): Rect {
  return rect(QUESTION_X, SPINE_Y - SIZE.question.height / 2, SIZE.question);
}

/** The soft tinted box behind a region's hub and its child slots. Always full size, so it never grows. */
export function regionRect(region: SlotRegion): Rect {
  return rect(REGION_X, REGION_TOP[region], SIZE.region);
}

/** A region's hub: the job, the tool and the status. */
export function hubRect(region: SlotRegion): Rect {
  return rect(REGION_X + HUB_INSET, REGION_TOP[region] + 10, SIZE.hub);
}

/**
 * Child slot `i` (0-based) of a region: a saved note or a web result, stacked under the hub. Pure, so a new child
 * lands in its own slot and nothing already on screen moves.
 */
export function slot(region: SlotRegion, i: number): Rect {
  if (!Number.isInteger(i) || i < 0 || i >= CHILD_SLOTS) throw new RangeError(`slot ${i} is outside 0 to ${CHILD_SLOTS - 1}`);
  const hub = hubRect(region);
  const y = hub.y + hub.height + HUB_TO_CHILD + i * (SIZE.child.height + CHILD_GAP);
  return rect(REGION_X + CHILD_INSET, y, SIZE.child);
}

/** Left edge of round `round`'s drafting hub (1-based rounds). */
function draftX(round: number): number {
  return DRAFT_X + (round - 1) * ROUND_SPAN;
}

/** The drafting hub of a round, on the spine. */
export function draftRect(round: number): Rect {
  return rect(draftX(round), SPINE_Y - SIZE.draft.height / 2, SIZE.draft);
}

/** Option `rank` (1-based) of a round: four fixed slots stacked around the spine, in reading order. */
export function optionRect(round: number, rank: number): Rect {
  if (!Number.isInteger(rank) || rank < 1 || rank > OPTION_SLOTS) throw new RangeError(`option rank ${rank} is outside 1 to ${OPTION_SLOTS}`);
  const total = OPTION_SLOTS * SIZE.option.height + (OPTION_SLOTS - 1) * OPTION_GAP;
  const top = SPINE_Y - total / 2;
  return rect(draftX(round) + OPTION_OFFSET, top + (rank - 1) * (SIZE.option.height + OPTION_GAP), SIZE.option);
}

/**
 * Step `i` (0-based) after the pick of option `pickedRank`: stacked beside the picked option and kept inside the
 * tree's height. It depends only on the pick, which never changes once made, so steps never move.
 */
export function stepRect(round: number, pickedRank: number, i: number): Rect {
  if (!Number.isInteger(i) || i < 0 || i >= STEP_SLOTS) throw new RangeError(`step ${i} is outside 0 to ${STEP_SLOTS - 1}`);
  const option = optionRect(round, Math.min(OPTION_SLOTS, Math.max(1, pickedRank)));
  const stack = STEP_SLOTS * SIZE.step.height + (STEP_SLOTS - 1) * STEP_GAP;
  const centered = option.y + option.height / 2 - SIZE.step.height / 2;
  const top = Math.min(Math.max(0, centered), TREE_HEIGHT - stack);
  return rect(draftX(round) + OUTCOME_OFFSET + OPTION_OFFSET, top + i * (SIZE.step.height + STEP_GAP), SIZE.step);
}

/** Where a round that ended with no pick says so: the outcome column, on the spine. */
export function roundEndRect(round: number): Rect {
  return rect(draftX(round) + OUTCOME_OFFSET + OPTION_OFFSET, SPINE_Y - SIZE.step.height / 2, SIZE.step);
}

/** The smallest rectangle around every rectangle given. */
export function unionRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The first round from the question to the options: the overview the camera holds while the agent works. */
export function firstRoundRect(): Rect {
  return unionRect([questionRect(), regionRect('notes'), regionRect('web'), draftRect(1), optionRect(1, 1), optionRect(1, OPTION_SLOTS)]);
}

/** The question and the two regions up to the drafting hub: the overview's left part, for a small screen. */
export function lookupRect(): Rect {
  return unionRect([questionRect(), regionRect('notes'), regionRect('web'), draftRect(1)]);
}

/** A round's drafting hub and its four option slots. */
export function optionsRect(round: number): Rect {
  return unionRect([draftRect(round), optionRect(round, 1), optionRect(round, OPTION_SLOTS)]);
}
