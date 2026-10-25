// Turns a validated plan into `answer_option` inputs (docs/spacetime.md 2.5, 3.6): sources, memory refs,
// provenance and the action JSON an errand or a call needs. Also builds the memory-first options that are read
// while a web search runs (PLAN D8).

import type { PreparedCall } from '@say-when/cartesia/server';
import type { CandidateOption, Recall } from '@say-when/moss';

import { DIRECT, LIMITS } from './contract.js';
import type { MemoryContext, Plan, PlannedOption, WebContext } from './planner/types.js';
import { MIN_PICK_OPTIONS } from './planner/validate.js';
import type { CallContact, OptionInput, Provenance, SourceRef, Tone } from './types.js';

/** Module limits on an option's sources (spacetime/src/agent.ts checkOption). */
const SOURCE_LIMITS = { perOption: 10, url: 500, placeId: 200, fetchedAt: 40, source: 40, memoryRefs: 20, memoryRef: 100 } as const;

/** Keeps a source only if the module will accept it; a web source whose link is too long is dropped, not cut. */
export function acceptedSource(source: SourceRef): SourceRef | null {
    if (source.source.length === 0 || source.source.length > SOURCE_LIMITS.source) return null;
    if (source.fetchedAt.length > SOURCE_LIMITS.fetchedAt) return null;
    const url = source.url && source.url.length <= SOURCE_LIMITS.url ? source.url : undefined;
    const placeId = source.placeId && source.placeId.length <= SOURCE_LIMITS.placeId ? source.placeId : undefined;
    if (!url && !placeId) return null;
    return { source: source.source, url, placeId, fetchedAt: source.fetchedAt };
}

export interface BuiltOptions {
    options: OptionInput[];
    /** For moss rankOptions: the same ids as `options` (`o1`..), with the best cited web score as support. */
    candidates: CandidateOption[];
    /** Call options the Dialer refused to prepare (consent, do-not-call, a hold, a stale errand). */
    droppedCalls: number;
}

/** What the Dialer's prepare() gives for a contact, or null when it refuses. */
export type PrepareCall = (contact: CallContact) => PreparedCall | null;

/** A call option's action JSON: the prepared call the module reads back and the CONFIRM must match. No number. */
export function callActionJson(prepared: PreparedCall): string {
    return JSON.stringify({
        requestId: prepared.requestId,
        contactId: prepared.contactId,
        recipientName: prepared.recipientName,
        readBack: prepared.readBack,
        digest: prepared.digest,
        expiresAt: prepared.expiresAt,
    });
}

function provenanceOf(sources: SourceRef[], memoryRefs: string[]): Provenance {
    if (sources.some((s) => s.source === 'maps')) return 'maps';
    if (sources.length > 0) return 'web';
    if (memoryRefs.length > 0) return 'memory';
    return 'model';
}

export function buildOptions(plan: Plan, memory: readonly MemoryContext[], web: readonly WebContext[], prepareCall: PrepareCall): BuiltOptions {
    const memoryByRef = new Map(memory.map((m) => [m.ref, m]));
    const webByRef = new Map(web.map((w) => [w.ref, w]));
    const options: OptionInput[] = [];
    const candidates: CandidateOption[] = [];
    let droppedCalls = 0;

    plan.options.forEach((planned: PlannedOption) => {
        const sources: SourceRef[] = [];
        const memoryRefs: string[] = [];
        let support = 0;
        for (const ref of planned.refs) {
            const m = memoryByRef.get(ref);
            if (m) {
                if (memoryRefs.length < SOURCE_LIMITS.memoryRefs && m.id.length <= SOURCE_LIMITS.memoryRef && !memoryRefs.includes(m.id)) memoryRefs.push(m.id);
                continue;
            }
            const w = webByRef.get(ref);
            if (!w) continue;
            support = Math.max(support, w.score);
            const source = acceptedSource(w.source);
            if (!source || sources.length >= SOURCE_LIMITS.perOption) continue;
            if (sources.some((s) => s.url === source.url && s.placeId === source.placeId)) continue;
            sources.push(source);
        }

        let actionJson = '';
        if (planned.kind === 'category' && DIRECT.categoryActionJson && planned.query) {
            actionJson = JSON.stringify({ query: planned.query });
        } else if (planned.kind === 'errand' && planned.errand) {
            const { form, fields } = planned.errand;
            actionJson = JSON.stringify({ formKey: form.formKey, formUrl: form.formUrl, formTitle: form.formTitle, fields });
        } else if (planned.kind === 'call' && planned.call) {
            const prepared = prepareCall(planned.call.contact);
            if (!prepared) {
                droppedCalls += 1;
                return;
            }
            actionJson = callActionJson(prepared);
        }

        const id = `o${options.length + 1}`;
        options.push({
            kind: planned.kind,
            label: planned.label.slice(0, LIMITS.optionLabel),
            text: planned.text.slice(0, LIMITS.optionText),
            tone: planned.tone,
            laugh: planned.laugh,
            provenance: provenanceOf(sources, memoryRefs),
            sources,
            memoryRefs,
            actionJson,
        });
        candidates.push({ id, text: planned.text, support });
    });
    // A refused call can leave a single option. The person still gets a choice, never one answer (PLAN D22).
    if (plan.answerMode === 'pick') {
        for (const pad of PAD_REPLIES) {
            if (options.length >= MIN_PICK_OPTIONS) break;
            if (options.some((o) => o.tone === pad.tone || o.text.toLowerCase() === pad.text.toLowerCase())) continue;
            candidates.push({ id: `o${options.length + 1}`, text: pad.text, support: 0 });
            options.push({ kind: 'reply', label: pad.label, text: pad.text, tone: pad.tone, laugh: false, provenance: 'stock', sources: [], memoryRefs: [], actionJson: '' });
        }
    }
    return { options, candidates, droppedCalls };
}

/**
 * Stock replies that fill a pick question back up to two options, each in its own tone, with an earpiece label. Direct
 * select also uses them to keep its Search option third (src/direct.ts withSearch).
 */
export const PAD_REPLIES: readonly { label: string; text: string; tone: Tone }[] = [
    { label: 'Not now', text: 'Not now.', tone: 'calm' },
    { label: 'Ask later', text: 'Ask me again later.', tone: 'neutral' },
    { label: 'Let me think', text: 'Let me think about it.', tone: 'warm' },
    { label: 'No thanks', text: 'No, thank you.', tone: 'firm' },
];

/** Reorders options by a moss ordering of their candidate ids (`o1`, `o2`, ...). Unknown ids keep their place. */
export function applyOrder(options: readonly OptionInput[], orderIds: readonly string[]): OptionInput[] {
    const byId = new Map(options.map((option, i) => [`o${i + 1}`, option]));
    const out: OptionInput[] = [];
    for (const id of orderIds) {
        const option = byId.get(id);
        if (option) {
            out.push(option);
            byId.delete(id);
        }
    }
    return [...out, ...byId.values()];
}

/** Tones for options that come straight from memory, in reading order. All distinct. */
const MEMORY_TONES: readonly Tone[] = ['warm', 'calm', 'neutral', 'firm'];

/**
 * The person's own past replies to this partner, as options to read while a web search runs (D8). Only when at
 * least two clear the score floor (docs/spacetime.md 7.4 step 3); never more than `max`.
 */
export function memoryFirstOptions(recall: Recall, max: number): OptionInput[] | null {
    const replies = recall.instant.map((reply) => reply.replace(/\s+/g, ' ').trim()).filter((reply) => reply.length > 0 && reply.length <= LIMITS.optionText);
    if (replies.length < 2) return null;
    const picked = replies.slice(0, Math.min(max, MEMORY_TONES.length));
    return picked.map((text, i) => {
        const memoryRefs = recall.hits
            .filter((hit) => hit.type === 'reply' && hit.reply !== null && hit.reply.replace(/\s+/g, ' ').trim() === text)
            .map((hit) => hit.id)
            .slice(0, SOURCE_LIMITS.memoryRefs);
        return {
            kind: 'reply' as const,
            // Scan mode only (no search runs in a direct select options job): the module reads the text.
            label: '',
            text,
            tone: MEMORY_TONES[i] ?? '',
            laugh: false,
            provenance: 'memory' as const,
            sources: [],
            memoryRefs,
            actionJson: '',
        };
    });
}

/** True for questions that read like yes or no ("Is the pharmacy open?"), where memory-first options would not fit. */
export function looksYesNo(question: string): boolean {
    return /^(is|are|was|were|do|does|did|can|could|will|would|should|shall|have|has|had|may|might|must|am)\b/i.test(question.trim());
}
