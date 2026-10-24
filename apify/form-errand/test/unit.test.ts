import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReadBackText, canonicalFormUrl, computeDigest, spokenValue } from '../src/digest.js';
import { nameScore } from '../src/fields.js';
import { checkUrl, isSignInUrl, matchesAllowedPrefix, parsePrefixes } from '../src/guards.js';
import { SubmitLedger, type RecordStore } from '../src/ledger.js';
import { HostPolicy, isPrivateAddress } from '../src/network.js';
import { DEFAULT_DISCLOSURE, InputError, parseInput } from '../src/validate.js';

const items = [
    { label: 'Who is this from?', value: 'Demo user', matchedBy: 'label' },
    { label: 'Details', value: 'Lunch  at noon', matchedBy: 'label' },
];

describe('digest', () => {
    it('is 16 hex characters and ignores field order and extra whitespace', () => {
        const a = computeDigest('https://forms.example.com/f', items);
        const b = computeDigest('https://forms.example.com/f', [
            { label: ' Details ', value: 'Lunch at noon', matchedBy: 'group' },
            items[0],
        ]);
        assert.match(a, /^[0-9a-f]{16}$/);
        assert.equal(a, b);
    });

    it('changes when any value changes', () => {
        const a = computeDigest('https://forms.example.com/f', items);
        const b = computeDigest('https://forms.example.com/f', [items[0], { ...items[1], value: 'Lunch at one' }]);
        assert.notEqual(a, b);
    });

    it('ignores query strings and fragments in the form URL but not the path', () => {
        assert.equal(canonicalFormUrl('https://f.example.com/a/viewform?usp=sf_link#x'), 'https://f.example.com/a/viewform');
        assert.equal(canonicalFormUrl('demo'), 'demo');
        assert.equal(
            computeDigest('https://f.example.com/a?x=1', items),
            computeDigest('https://f.example.com/a', items),
        );
        assert.notEqual(computeDigest('https://f.example.com/a', items), computeDigest('https://f.example.com/b', items));
    });

    it('builds a read-back that says every value and announces the note instead of reading it', () => {
        const text = buildReadBackText('Care team request', [
            items[0],
            { label: 'Details', value: `Lunch at noon\n\n${DEFAULT_DISCLOSURE}`, matchedBy: 'label' },
        ], { disclosureLabel: 'Details', disclosureText: DEFAULT_DISCLOSURE });
        assert.equal(
            text,
            'To Care team request. Who is this from: Demo user. Details: Lunch at noon, plus a note saying how it was sent. Confirm to send.',
        );
    });

    it('shortens long answers for speech', () => {
        const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
        assert.match(spokenValue(long), /and 15 more words on screen$/);
        assert.equal(spokenValue('  '), 'blank');
    });
});

describe('guards', () => {
    it('accepts only HTTPS addresses without credentials', () => {
        assert.equal(checkUrl('https://forms.example.com/f', { allowLocal: false }), null);
        assert.equal(checkUrl('http://forms.example.com/f', { allowLocal: false })?.code, 'bad_url');
        assert.equal(checkUrl('https://user:pw@forms.example.com/f', { allowLocal: false })?.code, 'bad_url');
        assert.equal(checkUrl('not a url', { allowLocal: false })?.code, 'bad_url');
        assert.equal(checkUrl('javascript:alert(1)', { allowLocal: false })?.code, 'bad_url');
    });

    it('allows local addresses only when asked', () => {
        assert.equal(checkUrl('http://127.0.0.1:8080/f', { allowLocal: false })?.code, 'bad_url');
        assert.equal(checkUrl('http://127.0.0.1:8080/f', { allowLocal: true }), null);
    });

    it('matches allowed prefixes only at a path boundary, after parsing both sides', () => {
        const prefixes = ['https://forms.example.com/a'];
        assert.equal(matchesAllowedPrefix('https://forms.example.com/a', prefixes), true);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/a/viewform', prefixes), true);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/a?x=1', prefixes), true);
        assert.equal(matchesAllowedPrefix('HTTPS://FORMS.EXAMPLE.COM:443/a/x', prefixes), true);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/ab', prefixes), false);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/a/../b', prefixes), false);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/a/%2e%2e/b', prefixes), false);
        assert.equal(matchesAllowedPrefix('https://forms.example.com.evil.test/a', ['https://forms.example.com']), false);
        assert.equal(matchesAllowedPrefix('http://forms.example.com/a', prefixes), false);
        assert.equal(matchesAllowedPrefix('https://forms.example.com/anything', ['https://forms.example.com/']), true);
        assert.equal(matchesAllowedPrefix('https://x.test/f', ['x.test']), false);
        assert.deepEqual(parsePrefixes(' https://a.test/x , ,https://b.test/ '), ['https://a.test/x', 'https://b.test/']);
    });

    it('recognizes sign-in pages', () => {
        assert.equal(isSignInUrl('https://accounts.google.com/ServiceLogin?continue=x'), true);
        assert.equal(isSignInUrl('https://example.com/login'), true);
        assert.equal(isSignInUrl('https://docs.google.com/forms/d/e/x/viewform'), false);
    });

    it('scores label matches exact, then prefix, then contains', () => {
        assert.equal(nameScore('Who is this from? *', 'Who is this from?'), 3);
        assert.equal(nameScore('Details about the request', 'Details'), 2);
        assert.equal(nameScore('Extra details', 'Details'), 1);
        assert.equal(nameScore('When?', 'Details'), 0);
    });
});

describe('network policy', () => {
    it('flags private, loopback, link-local and mapped addresses', () => {
        for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '[::1]']) {
            assert.equal(isPrivateAddress(ip), true, ip);
        }
        for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
    });

    it('allows only public http(s) hosts, using DNS for names', async () => {
        const resolver = async (host: string) => {
            if (host === 'inside.example') return [{ address: '10.0.0.5' }];
            if (host === 'mixed.example') return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
            if (host === 'gone.example') throw new Error('ENOTFOUND');
            return [{ address: '93.184.216.34' }];
        };
        const policy = new HostPolicy(false, resolver);
        assert.equal(await policy.allowed('https://forms.example.com/f'), true);
        assert.equal(await policy.allowed('https://inside.example/f'), false);
        assert.equal(await policy.allowed('https://mixed.example/f'), false);
        assert.equal(await policy.allowed('https://gone.example/f'), false);
        assert.equal(await policy.allowed('http://169.254.169.254/latest'), false);
        assert.equal(await policy.allowed('http://localhost:3000/'), false);
        assert.equal(await policy.allowed('file:///etc/passwd'), false);
        assert.equal(await policy.allowed('data:text/plain,hi'), true);
        assert.equal(await new HostPolicy(true, resolver).allowed('http://127.0.0.1:3000/'), true);
    });
});

describe('input validation', () => {
    it('defaults to a preview that cannot send', () => {
        const input = parseInput({ formUrl: 'demo', fields: [{ label: 'Details', value: 'x' }] });
        assert.equal(input.mode, 'preview');
        assert.equal(input.confirm, false);
        assert.equal(input.disclosureText, DEFAULT_DISCLOSURE);
        assert.equal(input.includeScreenshot, true);
    });

    it('rejects malformed digests, bad phrase lists, and empty answer lists', () => {
        assert.throws(() => parseInput({ formUrl: 'demo', mode: 'submit', fields: [{ label: 'a', value: 'b' }], confirmDigest: 'XYZ' }), InputError);
        assert.throws(() => parseInput({ formUrl: 'demo', fields: [{ label: 'a', value: 'b' }], confirmationPhrases: 'thanks' }), InputError);
        assert.throws(
            () => parseInput({ formUrl: 'demo', fields: [{ label: 'a', value: 'b' }], confirmationPhrases: Array.from({ length: 11 }, () => 'x') }),
            InputError,
        );
        assert.deepEqual(parseInput({ formUrl: 'demo', fields: [{ label: 'a', value: 'b' }], confirmationPhrases: ['(a+)+$'] }).confirmationPhrases, ['(a+)+$']);
        assert.throws(() => parseInput({ formUrl: 'demo', mode: 'preview', fields: [] }), InputError);
        assert.throws(() => parseInput({ formUrl: 'demo', mode: 'delete', fields: [{ label: 'a', value: 'b' }] }), InputError);
        assert.doesNotThrow(() => parseInput({ formUrl: 'demo', mode: 'inspect' }));
    });

    it('lets callers turn the disclosure note off', () => {
        assert.equal(parseInput({ formUrl: 'demo', fields: [{ label: 'a', value: 'b' }], disclosureText: '' }).disclosureText, '');
    });
});

class MemoryStore implements RecordStore {
    readonly data = new Map<string, unknown>();
    async getValue<T>(key: string): Promise<T | null> {
        return (this.data.get(key) as T | undefined) ?? null;
    }
    async setValue(key: string, value: unknown): Promise<void> {
        if (value === null) this.data.delete(key);
        else this.data.set(key, value);
    }
}

describe('submit ledger', () => {
    it('refuses the same digest twice inside the window and allows it after', async () => {
        let now = 1_000_000;
        const ledger = new SubmitLedger(new MemoryStore(), 10 * 60 * 1000, () => now);
        const first = await ledger.claim('demo', 'aaaaaaaaaaaaaaaa');
        assert.equal(first.duplicate, false);
        await ledger.finish(first.key, 'submitted', 'Request received.');
        const second = await ledger.claim('demo', 'aaaaaaaaaaaaaaaa');
        assert.equal(second.duplicate, true);
        if (second.duplicate) assert.equal(second.previous.confirmationText, 'Request received.');
        now += 11 * 60 * 1000;
        assert.equal((await ledger.claim('demo', 'aaaaaaaaaaaaaaaa')).duplicate, false);
    });

    it('blocks a second claim while the first is still in flight', async () => {
        const ledger = new SubmitLedger(new MemoryStore());
        const first = await ledger.claim('demo', 'bbbbbbbbbbbbbbbb');
        assert.equal(first.duplicate, false);
        assert.equal((await ledger.claim('demo', 'bbbbbbbbbbbbbbbb')).duplicate, true);
    });

    it('frees a claim when nothing was clicked', async () => {
        const ledger = new SubmitLedger(new MemoryStore());
        const first = await ledger.claim('demo', 'cccccccccccccccc');
        await ledger.release(first.key);
        assert.equal((await ledger.claim('demo', 'cccccccccccccccc')).duplicate, false);
    });
});
