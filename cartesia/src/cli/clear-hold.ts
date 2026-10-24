// npm run call:clear-hold -- --contact <id> --reason "<why it is safe to call again>"
// Clears a contact's holds after a person has checked with them. Each clear and its reason are added to
// CALL_HOLD_FILE, which is also the log. Prints a count only: never the contact id given, never a phone number.

import { CallConfigError, clearHoldInFile } from '../call.js';
import { arg, loadRepoEnv } from './args.js';

loadRepoEnv();
const argv = process.argv.slice(2);
const contactId = arg(argv, '--contact');
const reason = arg(argv, '--reason');
const file = process.env.CALL_HOLD_FILE?.trim();
if (!file || !contactId || !reason) {
    console.error('Set CALL_HOLD_FILE and pass --contact <id> and --reason "<why it is safe to call again>".');
    process.exit(1);
}
try {
    const cleared = clearHoldInFile({ file, contactId, reason });
    if (cleared === 0) {
        console.error('That contact has no hold.');
        process.exitCode = 1;
    } else {
        console.log(`Cleared ${cleared} hold${cleared === 1 ? '' : 's'}; the reason is saved in the hold file.`);
    }
} catch (error) {
    // CallConfigError messages are written to name no input: a line number or a rule, never a value.
    console.error(error instanceof CallConfigError ? error.message : 'Could not update the hold file.');
    process.exitCode = 1;
}
