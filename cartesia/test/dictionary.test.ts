import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkLexicon, DictionaryEchoError, lexiconFromNames, LexiconError, syncPronunciationDictionary } from '../src/dictionary.js';
import { checkLibraryVoices, listLibraryVoices } from '../src/voices.js';
import { fakeFetch, type FetchCall } from './fakes.js';

const KEY = 'sk_car_dict_key';
const entries = [
    { text: 'Siobhan', pronunciation: 'shi-VAWN' },
    { text: 'Gough Street', pronunciation: 'goff street' },
    { text: 'epinephrine', pronunciation: '<<ˌ|ɛ|p|ɪ|ˈ|n|ɛ|f|ɹ|ɪ|n>>' },
];

function echo(call: FetchCall) {
    const body = JSON.parse(call.body ?? '{}') as { items?: unknown };
    return { status: 200, body: { id: 'pdict_1', name: 'neurolingo-household', items: body.items } };
}

describe('pronunciation dictionary', () => {
    it('creates a private dictionary with pronunciation items', async () => {
        const fetch = fakeFetch(echo);
        const result = await syncPronunciationDictionary({ apiKey: KEY, name: 'neurolingo-household', entries, fetch });
        assert.deepEqual(result, { id: 'pdict_1', created: true, itemCount: 3 });
        const call = fetch.calls[0];
        assert.equal(call?.method, 'POST');
        assert.equal(call?.url, 'https://api.cartesia.ai/pronunciation-dicts/');
        assert.equal(call?.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(call?.headers['Cartesia-Version'], '2026-08-14');
        assert.deepEqual(JSON.parse(call?.body ?? ''), {
            name: 'neurolingo-household',
            access: 'private',
            items: [
                { text: 'Siobhan', pronunciation: 'shi-VAWN', case_sensitive: false },
                { text: 'Gough Street', pronunciation: 'goff street', case_sensitive: false },
                { text: 'epinephrine', pronunciation: '<<ˌ|ɛ|p|ɪ|ˈ|n|ɛ|f|ɹ|ɪ|n>>', case_sensitive: false },
            ],
        });
    });

    it('replaces the whole item list when updating', async () => {
        const fetch = fakeFetch(echo);
        const result = await syncPronunciationDictionary({ apiKey: KEY, name: '', entries, dictionaryId: 'pdict_1', fetch });
        assert.equal(result.created, false);
        assert.equal(fetch.calls[0]?.method, 'PATCH');
        assert.equal(fetch.calls[0]?.url, 'https://api.cartesia.ai/pronunciation-dicts/pdict_1');
        assert.deepEqual(Object.keys(JSON.parse(fetch.calls[0]?.body ?? '{}') as object), ['items']);
    });

    it('can send alias instead, the field SDK 4.2.0 uses', async () => {
        const fetch = fakeFetch(echo);
        await syncPronunciationDictionary({ apiKey: KEY, name: 'x', entries: entries.slice(0, 1), field: 'alias', fetch });
        assert.deepEqual((JSON.parse(fetch.calls[0]?.body ?? '{}') as { items: unknown[] }).items, [{ text: 'Siobhan', alias: 'shi-VAWN', case_sensitive: false }]);
    });

    it('fails loudly when the echo drops the pronunciations', async () => {
        const fetch = fakeFetch(() => ({ status: 200, body: { id: 'pdict_1', items: [{ text: 'Siobhan', case_sensitive: false }] } }));
        await assert.rejects(
            syncPronunciationDictionary({ apiKey: KEY, name: 'x', entries: entries.slice(0, 1), fetch }),
            (error: unknown) => error instanceof DictionaryEchoError && /Try field "alias"/.test(error.message),
        );
    });

    it('rejects colliding and malformed entries by position, not by name', () => {
        assert.throws(() => checkLexicon([entries[0]!, { text: 'siobhan', pronunciation: 'x' }]), (error: unknown) => error instanceof LexiconError && !error.message.includes('iobhan'));
        assert.throws(() => checkLexicon([
            { text: 'cat', pronunciation: 'a', caseSensitive: true },
            { text: 'Cat', pronunciation: 'b', caseSensitive: true },
        ]), LexiconError);
        assert.doesNotThrow(() => checkLexicon([
            { text: 'LaTeX', pronunciation: 'lay-tek', caseSensitive: true },
            { text: 'latex', pronunciation: 'lay-tex', caseSensitive: true },
        ]));
        assert.throws(() => checkLexicon([{ text: 'x', pronunciation: '<<ˈ|k' }]), LexiconError);
        assert.throws(() => checkLexicon([{ text: ' ', pronunciation: 'x' }]), LexiconError);
    });

    it('makes entries only where a pronunciation was written down, and keyterms from every name', () => {
        const lexicon = lexiconFromNames({
            household: [{ name: 'Siobhan', sayAs: 'shi-VAWN' }, { name: 'Khadim' }],
            places: [{ name: 'Tartine Manufactory' }, { name: 'Gough Street', sayAs: 'goff street' }],
        });
        assert.deepEqual(lexicon.entries, [
            { text: 'Siobhan', pronunciation: 'shi-VAWN', caseSensitive: false },
            { text: 'Gough Street', pronunciation: 'goff street', caseSensitive: false },
        ]);
        assert.deepEqual(lexicon.keyterms, ['Siobhan', 'Khadim', 'Tartine Manufactory', 'Gough Street']);
        assert.equal(lexicon.droppedKeyterms, 0);
    });
});

describe('library voices', () => {
    const skylar = {
        id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
        name: 'Skylar',
        tagline: 'Friendly Guide',
        description: 'Approachable American female ideal for customer care and support.',
        gender: 'feminine',
        is_owner: false,
        status: 'active',
        accents: [{ accent: 'general-american', locale: 'en-US', is_native: true }, { accent: 'mexican', locale: 'es-MX', is_native: false }],
    };
    const tessa = { id: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b', name: 'Tessa', is_owner: false, is_pro: false };
    const clone = { id: 'v_clone', name: 'Our clone', is_owner: true };
    const pro = { id: 'v_pro', name: 'Pro clone', is_owner: false, is_pro: true };

    it('pages through GET /voices and never returns owned or Pro clone voices', async () => {
        const fetch = fakeFetch((call) => {
            const url = new URL(call.url);
            if (!url.searchParams.has('starting_after')) return { status: 200, body: { data: [skylar, clone], has_more: true, next_page: 'v_next' } };
            return { status: 200, body: { data: [tessa, pro], has_more: false, next_page: null } };
        });
        const voices = await listLibraryVoices({ apiKey: KEY, q: 'warm', language: 'en', gender: 'feminine', fetch });
        assert.deepEqual(voices.map((voice) => voice.id), [skylar.id, tessa.id]);
        const first = new URL(fetch.calls[0]?.url ?? '');
        assert.equal(first.pathname, '/voices');
        assert.deepEqual([...first.searchParams.entries()], [['limit', '100'], ['q', 'warm'], ['language', 'en'], ['gender', 'feminine']]);
        assert.equal(new URL(fetch.calls[1]?.url ?? '').searchParams.get('starting_after'), 'v_next');
        assert.deepEqual(voices[0]?.accents, [
            { accent: 'general-american', locale: 'en-US', isNative: true },
            { accent: 'mexican', locale: 'es-MX', isNative: false },
        ]);
        assert.equal(voices[0]?.playgroundUrl, `https://play.cartesia.ai/voices/${skylar.id}`);
    });

    it('confirms configured ids are library voices', async () => {
        const fetch = fakeFetch((call) => {
            const q = new URL(call.url).searchParams.get('q');
            return { status: 200, body: { data: q === skylar.id ? [skylar] : q === clone.id ? [clone] : [], has_more: false } };
        });
        const results = await checkLibraryVoices({ apiKey: KEY, ids: [skylar.id, clone.id, 'v_missing'], fetch });
        assert.deepEqual(results, [
            { id: skylar.id, ok: true, name: 'Skylar' },
            { id: clone.id, ok: false, reason: 'not a library voice' },
            { id: 'v_missing', ok: false, reason: 'not found' },
        ]);
    });
});
