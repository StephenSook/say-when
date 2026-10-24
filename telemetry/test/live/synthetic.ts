// The synthetic test session the live tests write, with its answers computed here, independently of the tracker.
import type { Micros } from '../../src/types.js';
import { Scenario } from '../fixtures.js';

export interface Expected {
    commands: number;
    falseActivations: number;
    idleMs: number;
    timesToPick: number[];
    /** Rows of action_outcomes: 0, or 2 with `errand`. */
    outcomes: number;
}

/**
 * A test session whose answers are known in advance. Times are `anchorMs` (epoch milliseconds) plus seconds, on whole
 * milliseconds. With `errand`, an errand is drafted and submitted at the session's last moment (400 s), so the session
 * also writes action_outcomes rows; the rest it adds starts and ends there, so the rest total does not change.
 */
export function syntheticSession(anchorMs: number, options: { errand?: boolean } = {}): { events: Scenario['events']; expected: Expected } {
    const anchor: Micros = BigInt(anchorMs) * 1_000n;
    const ms = (s: number): number => Math.round(s * 1_000);
    const at = (s: number): Micros => anchor + BigInt(ms(s)) * 1_000n;
    /** Seconds (epoch) whose midpoint lies in [a, b): the rule the tracker uses, computed here on its own. */
    const secondsIn = (a: number, b: number): number => Math.ceil((anchorMs + ms(b) - 500) / 1_000) - Math.ceil((anchorMs + ms(a) - 500) / 1_000);

    const s = new Scenario(1n).start(at(0)).ready();
    let restSeconds = 0;
    let restStart = 0;
    const rest = (until: number) => {
        restSeconds += secondsIn(restStart, until);
    };
    // The station's device_status row every 2 s, as the module refreshes it, interleaved in time order.
    let lastBeat = 0;
    const beatTo = (until: number) => {
        while (lastBeat + 2 <= until) {
            lastBeat += 2;
            s.tick(at(lastBeat));
        }
    };
    // Three minutes at rest with three misfires that had nothing to act on.
    beatTo(20);
    s.gesture(at(20), 'NO', 'ignored:idle');
    beatTo(80);
    s.gesture(at(80), 'CONFIRM', 'ignored:nothing_to_confirm');
    beatTo(140);
    s.gesture(at(140), 'NO', 'ignored:idle');
    beatTo(180);
    rest(180);
    // 21 questions, each picked on its first option after 1.0 s, 1.2 s, ... 5.0 s.
    const timesToPick: number[] = [];
    for (let k = 0; k <= 20; k++) {
        const t0 = 180 + k * 8;
        const ttp = 1 + 0.2 * k;
        const q = BigInt(100 + k);
        if (k > 0) rest(t0);
        beatTo(t0);
        s.preparing(at(t0), q).read(at(t0 + 0.5), q, 1);
        beatTo(t0 + 0.5 + ttp);
        s.pick(at(t0 + 0.5 + ttp), q, 1, 'reply');
        s.gesture(at(t0 + 0.5 + ttp), 'YES', 'accepted:pick', { questionId: q, optionId: 1_000n + q, cursor: 1 });
        s.veto(at(t0 + 0.5 + ttp));
        beatTo(t0 + 0.5 + ttp + 0.7);
        s.idle(at(t0 + 0.5 + ttp + 0.7), 'picked');
        beatTo(t0 + 7);
        restStart = t0 + 0.5 + ttp + 0.7;
        timesToPick.push(ms(ttp));
    }
    // A STOP at rest pauses (it acted, so it is not a false activation); a second STOP while paused had nothing to do.
    // A deliberate pause is still rest.
    beatTo(352);
    s.gesture(at(352), 'STOP', 'accepted:pause');
    s.pause(at(352), 'stop');
    beatTo(360);
    s.gesture(at(360), 'STOP', 'ignored:already_paused');
    beatTo(400);
    rest(400);
    if (options.errand) s.errand(at(400), 1n, 'drafted').errand(at(400), 1n, 'submitted');
    return {
        events: s.events,
        expected: { commands: 3 + 21 + 2, falseActivations: 4, idleMs: restSeconds * 1_000, timesToPick, outcomes: options.errand ? 2 : 0 },
    };
}
