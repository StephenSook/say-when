import type { Affinity, MemoryStore } from './memory.js';

export interface CandidateOption {
    id: string;
    text: string;
    /** Best score among the passages this option cites, 0 to 1. Missing means 0. */
    support?: number;
    /** Escape options such as "something else" or "more" stay last, in the planner's order, in both orders. */
    last?: boolean;
}

export interface RankedOption {
    id: string;
    text: string;
    support: number;
    affinity: number;
    /** Ids of the memory items behind the affinity. Content-free. */
    evidence: string[];
    /** The value this order sorted on. */
    score: number;
    last: boolean;
}

export interface Ordering {
    /** Read when the memory toggle is on: weighted memory affinity plus support. */
    withMemory: RankedOption[];
    /** Read when it is off: support alone, ties in the planner's order. */
    withoutMemory: RankedOption[];
}

export interface RankWeights {
    affinity: number;
    support: number;
}

/** Starting weights from the research note. Tune them on held-out real questions, not on the memory's own items. */
export const DEFAULT_WEIGHTS: RankWeights = { affinity: 0.6, support: 0.4 };

const unit = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Orders the options both ways at once, so the toggle can switch orders and the counter can compare them.
 * Scores across separate queries compare because Moss's score is vector similarity under one model, which alpha and
 * rank never change. A keyword-only query would score every hit 0, which is why alpha 0 is never used here.
 */
export function orderOptions(options: readonly CandidateOption[], affinities: readonly Affinity[], weights: RankWeights = DEFAULT_WEIGHTS): Ordering {
    if (new Set(options.map((option) => option.id)).size !== options.length) throw new RangeError('Option ids must be unique.');
    const byId = new Map(affinities.map((affinity) => [affinity.optionId, affinity]));
    const base = options.map((option, index) => {
        const affinity = byId.get(option.id);
        return {
            index,
            id: option.id,
            text: option.text,
            support: unit(option.support),
            affinity: unit(affinity?.score),
            evidence: affinity?.evidence ?? [],
            last: option.last === true,
        };
    });
    type Base = (typeof base)[number];
    const sortBy = (key: (option: Base) => number): RankedOption[] =>
        [...base]
            .sort((a, b) => {
                if (a.last !== b.last) return a.last ? 1 : -1;
                if (a.last) return a.index - b.index;
                return key(b) - key(a) || a.index - b.index;
            })
            .map((b) => ({ id: b.id, text: b.text, support: b.support, affinity: b.affinity, evidence: b.evidence, score: key(b), last: b.last }));
    return {
        withMemory: sortBy((option) => weights.affinity * option.affinity + weights.support * option.support),
        withoutMemory: sortBy((option) => option.support),
    };
}

/** How many options are read before the chosen one in this order. */
export function readBefore(order: ReadonlyArray<{ id: string }>, chosenId: string): number {
    const position = order.findIndex((option) => option.id === chosenId);
    if (position < 0) throw new RangeError('The chosen option is not in this order.');
    return position;
}

export interface ScanCount {
    withMemory: number;
    withoutMemory: number;
}

/** The dashboard counter: options read before the chosen one, with memory and without, over a run. */
export class ScanCounter {
    private questions = 0;
    private withMemory = 0;
    private withoutMemory = 0;

    record(ordering: Ordering, chosenId: string): ScanCount {
        const count = { withMemory: readBefore(ordering.withMemory, chosenId), withoutMemory: readBefore(ordering.withoutMemory, chosenId) };
        this.questions += 1;
        this.withMemory += count.withMemory;
        this.withoutMemory += count.withoutMemory;
        return count;
    }

    totals(): { questions: number; withMemory: number; withoutMemory: number; saved: number } {
        return { questions: this.questions, withMemory: this.withMemory, withoutMemory: this.withoutMemory, saved: this.withoutMemory - this.withMemory };
    }

    reset(): void {
        this.questions = 0;
        this.withMemory = 0;
        this.withoutMemory = 0;
    }
}

/** Runs the affinity queries for this partner and returns both orders. Escape options need no query. */
export async function rankOptions(
    memory: MemoryStore,
    partnerId: string,
    options: readonly CandidateOption[],
    weights: RankWeights = DEFAULT_WEIGHTS,
): Promise<Ordering> {
    const affinities = await memory.affinity(
        options.filter((option) => option.last !== true),
        partnerId,
    );
    return orderOptions(options, affinities, weights);
}
