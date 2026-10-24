// Ink-2 keyterm prompting: up to 100 terms and 1,200 characters per connection, fixed when the socket opens.

export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_CHARS = 1200;

// The keyterm guide says to avoid generic, common words.
const COMMON_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'you']);

/**
 * Merges keyterm lists in priority order (household lexicon first, then the current Apify place names),
 * keeping the first spelling of each term, since exact spelling and capitalization matter.
 * Terms past the limits are counted in `dropped`, never sent.
 */
export function buildKeyterms(...lists: ReadonlyArray<readonly string[] | undefined>): { keyterms: string[]; dropped: number } {
    const seen = new Set<string>();
    const keyterms: string[] = [];
    let total = 0;
    let dropped = 0;
    for (const list of lists) {
        for (const raw of list ?? []) {
            const term = String(raw).replace(/\s+/g, ' ').trim();
            if (!term) continue;
            const key = term.toLowerCase();
            if (seen.has(key)) continue;
            if (COMMON_WORDS.has(key)) {
                dropped++;
                continue;
            }
            if (keyterms.length >= MAX_KEYTERMS || total + term.length > MAX_KEYTERM_CHARS) {
                dropped++;
                continue;
            }
            seen.add(key);
            keyterms.push(term);
            total += term.length;
        }
    }
    return { keyterms, dropped };
}
