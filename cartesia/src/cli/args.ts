// Small helpers shared by the command-line tools. They read keys from the environment and never print them.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads the repo's .env.local if it exists (Node's built-in loader; real environment variables win). */
export function loadRepoEnv(): void {
    const path = fileURLToPath(new URL('../../../.env.local', import.meta.url));
    if (existsSync(path)) process.loadEnvFile(path);
}

/** The value after `--name`, or undefined. */
export function arg(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value !== undefined && !value.startsWith('--') ? value : undefined;
}

export function flag(argv: readonly string[], name: string): boolean {
    return argv.includes(name);
}

/** Positional arguments, skipping flags and their values. */
export function positionals(argv: readonly string[], valueFlags: readonly string[] = []): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i] ?? '';
        if (valueFlags.includes(item)) {
            i++;
            continue;
        }
        if (!item.startsWith('--')) out.push(item);
    }
    return out;
}
