import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  countWords,
  formatAge,
  formatClock,
  formatClockDuration,
  formatClockShort,
  formatCount,
  formatDate,
  formatMs,
  formatSeconds,
  formatTimeLeft,
  maskPhoneNumbers,
  replacePhoneNumbers,
  timeZoneLabel,
  toMillis,
} from '../lib/format';

describe('formatMs', () => {
  test('whole milliseconds with separators', () => {
    assert.equal(formatMs(81), '81 ms');
    assert.equal(formatMs(1104), '1,104 ms');
    assert.equal(formatMs(80.6), '81 ms');
  });

  test('never negative, empty for nonsense', () => {
    assert.equal(formatMs(-5), '0 ms');
    assert.equal(formatMs(Number.NaN), '');
  });
});

describe('formatSeconds', () => {
  test('matches the mockup values', () => {
    assert.equal(formatSeconds(80), '0.08 s');
    assert.equal(formatSeconds(412), '0.4 s');
    assert.equal(formatSeconds(1800), '1.8 s');
    assert.equal(formatSeconds(2900), '2.9 s');
  });

  test('rounds across the 10 s and 60 s steps without odd values', () => {
    assert.equal(formatSeconds(1000), '1.0 s');
    assert.equal(formatSeconds(9960), '10 s');
    assert.equal(formatSeconds(12_345), '12 s');
    assert.equal(formatSeconds(59_600), '1 min');
    assert.equal(formatSeconds(65_000), '1 min 5 s');
    assert.equal(formatSeconds(120_000), '2 min');
  });

  test('zero, negative and nonsense', () => {
    assert.equal(formatSeconds(0), '0 s');
    assert.equal(formatSeconds(-30), '0 s');
    assert.equal(formatSeconds(Number.POSITIVE_INFINITY), '');
  });
});

describe('formatClockDuration and formatTimeLeft', () => {
  test('call and ring timers', () => {
    assert.equal(formatClockDuration(0), '0:00');
    assert.equal(formatClockDuration(42_000), '0:42');
    assert.equal(formatClockDuration(65_900), '1:05');
    assert.equal(formatClockDuration(3_723_000), '1:02:03');
  });

  test('countdowns round up, so time left never reads 0 early', () => {
    assert.equal(formatTimeLeft(5_200), '6 s left');
    assert.equal(formatTimeLeft(6_000), '6 s left');
    assert.equal(formatTimeLeft(1), '1 s left');
    assert.equal(formatTimeLeft(0), '0 s left');
    assert.equal(formatTimeLeft(-400), '0 s left');
  });
});

describe('clock times in Pacific time', () => {
  // 19:41:06 UTC on Oct 24, 2026 is 12:41:06 PDT (UTC-7).
  const noonish = Date.UTC(2026, 9, 24, 19, 41, 6);

  test('24-hour clock with seconds, from a number, an ISO string or a Date', () => {
    assert.equal(formatClock(noonish), '12:41:06');
    assert.equal(formatClock(new Date(noonish).toISOString()), '12:41:06');
    assert.equal(formatClock(new Date(noonish)), '12:41:06');
    assert.equal(formatClockShort(noonish), '12:41');
  });

  test('just after midnight reads 00, not 24', () => {
    assert.equal(formatClock(Date.UTC(2026, 9, 25, 7, 5, 0)), '00:05:00');
  });

  test('short dates and the zone label', () => {
    assert.equal(formatDate(Date.UTC(2026, 9, 12, 19, 0)), 'Oct 12');
    assert.equal(timeZoneLabel(noonish), 'PDT');
    assert.equal(timeZoneLabel(Date.UTC(2026, 11, 20, 20, 0)), 'PST');
  });

  test('unreadable input gives an empty string', () => {
    assert.equal(formatClock('not a time'), '');
    assert.ok(Number.isNaN(toMillis('not a time')));
  });
});

describe('formatAge', () => {
  const now = Date.UTC(2026, 9, 24, 19, 0, 0);

  test('steps from just now to days', () => {
    assert.equal(formatAge(now - 1_000, now), 'just now');
    assert.equal(formatAge(now - 8_000, now), '8 s ago');
    assert.equal(formatAge(now - 3 * 60_000, now), '3 min ago');
    assert.equal(formatAge(now - 2 * 3_600_000, now), '2 h ago');
    assert.equal(formatAge(now - 3 * 86_400_000, now), '3 d ago');
  });

  test('a clock slightly ahead of ours reads as just now', () => {
    assert.equal(formatAge(now + 2_000, now), 'just now');
  });
});

describe('formatCount and countWords', () => {
  test('nouns follow the count', () => {
    assert.equal(formatCount(1, 'row'), '1 row');
    assert.equal(formatCount(6, 'row'), '6 rows');
    assert.equal(formatCount(1204, 'word'), '1,204 words');
    assert.equal(formatCount(2, 'search', 'searches'), '2 searches');
    assert.equal(formatCount(0, 'hit'), '0 hits');
  });

  test('counts the words in a question', () => {
    assert.equal(countWords('Where can we get dinner near the hospital tonight?'), 9);
    assert.equal(countWords('   '), 0);
  });
});

describe('maskPhoneNumbers', () => {
  test('hides the common phone number shapes', () => {
    assert.equal(maskPhoneNumbers("To reach the team, call (510) 555-0100."), 'To reach the team, call [number hidden].');
    assert.equal(maskPhoneNumbers('Call +1 510 555 0100 now'), 'Call [number hidden] now');
    assert.equal(maskPhoneNumbers('or 510.555.0100'), 'or [number hidden]');
    assert.equal(maskPhoneNumbers('or 5105550100'), 'or [number hidden]');
    assert.equal(maskPhoneNumbers('or 555-0100'), 'or [number hidden]');
  });

  test('leaves times, prices, ratings and short counts alone', () => {
    const text = 'At 12:41:06, 7 pm, $1,104, rated 4.6 by 212 people, 0.3 mi away, level 2.';
    assert.equal(maskPhoneNumbers(text), text);
  });

  test('replacePhoneNumbers: the same match, with spoken words in its place (taken literally)', () => {
    assert.equal(replacePhoneNumbers('Call me at (510) 555-0100, or +1 510 555 0101?', 'a number'), 'Call me at a number, or a number?');
    assert.equal(replacePhoneNumbers('Call 5105550100', '$& $1'), 'Call $& $1');
    const text = 'At 12:41:06, 7 pm, $1,104.';
    assert.equal(replacePhoneNumbers(text, 'a number'), text);
  });
});
