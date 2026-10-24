// npm run voices -- [--q warm] [--language en] [--gender feminine]   list library voices to audition
// npm run voices -- --check                                          confirm the configured ids are library voices

import { checkLibraryVoices, listLibraryVoices, type Gender } from '../voices.js';
import { DEFAULT_VOICES } from '../tones.js';
import { apiKeyFromEnv } from '../server.js';
import { arg, flag, loadRepoEnv } from './args.js';

loadRepoEnv();
const argv = process.argv.slice(2);
const apiKey = apiKeyFromEnv();

if (flag(argv, '--check')) {
    const ids = [
        process.env.CARTESIA_ASSISTANT_VOICE_ID?.trim() || DEFAULT_VOICES.assistant,
        process.env.CARTESIA_REPLY_VOICE_ID?.trim() || DEFAULT_VOICES.reply,
    ];
    const results = await checkLibraryVoices({ apiKey, ids });
    for (const result of results) console.log(`${result.ok ? 'ok ' : 'NO '} ${result.id}  ${result.ok ? result.name : result.reason}`);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
} else {
    const gender = arg(argv, '--gender') as Gender | undefined;
    const voices = await listLibraryVoices({ apiKey, q: arg(argv, '--q'), language: arg(argv, '--language'), gender });
    for (const voice of voices) {
        const accents = voice.accents.map((a) => `${a.locale}${a.isNative ? '*' : ''}`).join(' ');
        console.log(`${voice.id}  ${voice.name}  ${voice.tagline}  [${accents}]  ${voice.playgroundUrl}`);
    }
    console.log(`${voices.length} library voices. * marks the voice's native accent.`);
}
