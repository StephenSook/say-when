/**
 * What the stage's side column shows under the brain slot, from the same view the Conversation screen builds
 * (components/conversation/model.ts `buildConversationView`), so the two screens can never disagree. Pure.
 *
 * One block at a time, in this order:
 * - 'ear': an option (or the yes or no prompt) is in the earpiece now.
 * - 'picked': YES picked an option: the veto, then where its errand or call is.
 * - 'note': listening, drafting, getting the voice ready, or an error.
 * - 'ending': the turn ended without a pick.
 * - 'between': options exist and nothing is being read this moment.
 */
import type { AnswerOption } from '@/lib/data/types';
import type { AgentStatus, ConversationView, CursorView, Ending, TurnNote } from '../conversation/model';

export type NowBlock =
  | { kind: 'ear'; option: AnswerOption | null; cursor: CursorView; prompt: boolean }
  | { kind: 'picked'; option: AnswerOption; vetoing: boolean; agent: AgentStatus | null }
  | { kind: 'note'; note: TurnNote }
  | { kind: 'ending'; ending: Ending }
  | { kind: 'between' };

export function nowBlock(view: ConversationView): NowBlock {
  const { cursor } = view;
  if (cursor !== null) {
    const option = cursor.optionId === null ? null : (view.options.find((o) => o.id === cursor.optionId) ?? null);
    // A cursor on an option that is not on screen has nothing to show; the yes or no prompt has no option on purpose.
    if (option !== null || (cursor.optionId === null && view.yesNo)) {
      return { kind: 'ear', option, cursor, prompt: option === null };
    }
  }
  if (view.picked !== null) return { kind: 'picked', option: view.picked, vetoing: view.vetoing, agent: view.agent };
  if (view.note !== null) return { kind: 'note', note: view.note };
  if (view.ending !== null) return { kind: 'ending', ending: view.ending };
  return { kind: 'between' };
}
