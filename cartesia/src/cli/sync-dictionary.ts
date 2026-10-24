// npm run dict:sync -- --file private/lexicon.json [--name neurolingo-household] [--field alias]
// The lexicon file is private (gitignored): { "household": [{ "name": "...", "sayAs": "..." }], "places": [...] }.
// Creates the dictionary, or replaces its items when CARTESIA_PRONUNCIATION_DICT_ID is set. Prints counts, never names.

import { readFileSync } from 'node:fs';

import { lexiconFromNames, syncPronunciationDictionary, type ItemField, type NameEntry } from '../dictionary.js';
import { apiKeyFromEnv } from '../server.js';
import { arg, loadRepoEnv } from './args.js';

loadRepoEnv();
const argv = process.argv.slice(2);
const file = arg(argv, '--file');
if (!file) {
    console.error('Pass --file with the private lexicon JSON.');
    process.exit(1);
}
const lexicon = JSON.parse(readFileSync(file, 'utf8')) as { household?: NameEntry[]; places?: NameEntry[] };
const { entries, keyterms, droppedKeyterms } = lexiconFromNames(lexicon);
const field = (arg(argv, '--field') ?? 'pronunciation') as ItemField;
const dictionaryId = process.env.CARTESIA_PRONUNCIATION_DICT_ID?.trim() || undefined;
const result = await syncPronunciationDictionary({
    apiKey: apiKeyFromEnv(),
    name: arg(argv, '--name') ?? 'neurolingo-household',
    entries,
    dictionaryId,
    field,
});
console.log(`dictionary ${result.id} ${result.created ? 'created' : 'updated'}: ${result.itemCount} entries`);
console.log(`${keyterms.length} keyterms from the same names (${droppedKeyterms} over the Ink-2 limits)`);
if (result.created) console.log('Put this id in CARTESIA_PRONUNCIATION_DICT_ID.');
