/**
 * Helpers for mapping generated SpacetimeDB rows onto lib/data/types.ts. Pure, so they are tested
 * now; lib/data/spacetime-bindings.ts uses them once it is wired to the generated bindings.
 */
import { COMMANDS, STAGES, type CommandName, type PipelineStatus, type Stage, type StageDetailMap } from './types';

/** A SpacetimeDB Timestamp (spacetimedb 2.13.0 `Timestamp.toMillis(): bigint`) as epoch milliseconds. */
export function timestampToMillis(ts: { toMillis(): bigint } | null | undefined): number | null {
  if (!ts) return null;
  return Number(ts.toMillis());
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * The D11 command names only: YES, NO, CONFIRM, STOP, plus the system's HEADSET_OFF.
 * Anything else, including the names from the first command map (PLAN D3), is not a command; drop the row.
 */
export function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function asPipelineStatus(value: string): PipelineStatus | null {
  return value === 'started' || value === 'ok' || value === 'error' ? value : null;
}

/**
 * `pipeline_event.detail` as a parsed object (docs/ui.md gap 2: a JSON string per stage).
 * Never throws: unreadable JSON becomes a detail whose `error` carries the raw text.
 * Retrieve details pass through `withoutMemoryText`, so memory text can only arrive as `sharedText`.
 */
export function parseDetail<S extends Stage>(stage: S, json: string | null | undefined): StageDetailMap[S] {
  if (json === null || json === undefined || json.trim() === '') return {} as StageDetailMap[S];
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (stage === 'retrieve') return withoutMemoryText(value as StageDetailMap['retrieve']) as StageDetailMap[S];
      return value as StageDetailMap[S];
    }
  } catch {
    // Fall through to the error below.
  }
  return { error: { sentence: "This step's details could not be read.", raw: json.slice(0, 500) } } as StageDetailMap[S];
}

/** The sentence a failed step shows when its payload carries none. The same words as Live data's fallbacks. */
export const STAGE_ERROR_SENTENCES: Readonly<Record<Stage, string>> = {
  listen: 'Could not hear the question.',
  search: 'The search failed.',
  retrieve: 'Could not recall memory.',
  plan: 'Could not draft options. Ask again.',
  speak: 'Could not play the option.',
  select: 'Could not record the pick.',
  errand: 'The errand failed.',
  call: 'The call failed.',
};

/** Count names that would hide a payload list of the same name, and the names they take instead. */
const COUNT_RENAMES: Readonly<Record<string, string>> = { rows: 'rowCount', hits: 'hitCount', words: 'wordCount' };

/** A JSON object, or null for anything else. `bad` collects what could not be read. */
function jsonObject(json: string | null | undefined, bad: string[]): Record<string, unknown> | null {
  if (json === null || json === undefined || json.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  bad.push(json.slice(0, 200));
  return null;
}

/**
 * One pipeline event's `detail` for the screens, from the three places the module keeps apart
 * (docs/spacetime.md 2.9 and 7.1): the content-free label in `pipeline_event.detail`, the numbers in
 * `counts_json`, and the content in `board_payloads.payload_json` (there only while the room shares
 * text). Pass null for a payload the board does not share.
 * - Counts first, then the payload, so content wins on a shared name. A count named like a payload
 *   list (`rows`, `hits`, `words`) is renamed (`rowCount`, `hitCount`, `wordCount`), so a number never
 *   stands in for the list.
 * - The label rides as `label`. An `error` status gets an error whose raw text is the label (for
 *   example "failed: timeout"), unless the payload brings its own.
 * - Retrieve hits lose any memory text that is not `sharedText` (moss/README.md).
 * Never throws: JSON that cannot be read is skipped and named in the error's raw text.
 */
export function pipelineDetail<S extends Stage>(
  stage: S,
  status: PipelineStatus,
  label: string | null | undefined,
  countsJson: string | null | undefined,
  payloadJson: string | null | undefined,
): StageDetailMap[S] {
  const bad: string[] = [];
  const counts = jsonObject(countsJson, bad) ?? {};
  const payload = jsonObject(payloadJson, bad) ?? {};
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== 'number' && typeof value !== 'boolean') continue;
    const name = typeof value === 'number' ? (COUNT_RENAMES[key] ?? key) : key;
    detail[name] = value;
  }
  Object.assign(detail, payload);
  const cleanLabel = label?.trim();
  if (cleanLabel) detail.label = cleanLabel;
  if (status === 'error' && detail.error === undefined) {
    detail.error = { sentence: STAGE_ERROR_SENTENCES[stage], raw: cleanLabel || undefined };
  }
  if (bad.length > 0 && detail.error === undefined) {
    detail.error = { sentence: "This step's details could not be read.", raw: bad.join(' ') };
  }
  if (stage === 'retrieve') return withoutMemoryText(detail as StageDetailMap['retrieve']) as StageDetailMap[S];
  return detail as StageDetailMap[S];
}

/**
 * Drops `text` from every hit that is not a web hit (moss/README.md: memory text never goes to a
 * screen unless the person shared it, and then it arrives as `sharedText`).
 */
export function withoutMemoryText(detail: StageDetailMap['retrieve']): StageDetailMap['retrieve'] {
  if (!Array.isArray(detail.hits)) return detail;
  return {
    ...detail,
    hits: detail.hits.map((hit) => {
      if (hit.origin === 'web' || hit.text === undefined) return hit;
      const { text: _dropped, ...rest } = hit;
      return rest;
    }),
  };
}

/** Copies rows out of a client cache iterator and sorts them oldest first. */
export function sortedBy<T>(rows: Iterable<T>, time: (row: T) => number): T[] {
  return Array.from(rows).sort((a, b) => time(a) - time(b));
}
