import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

describe('source guard', () => {
    it('never uploads, loads a cloud index, polls, uses the inference gateway, or logs', () => {
        const files = readdirSync(src).filter((name) => name.endsWith('.ts'));
        // A guard that walks nothing would pass in the same words as one that walks everything.
        assert.ok(files.length >= 6, `walked ${files.length} files`);
        for (const name of files) {
            const text = readFileSync(join(src, name), 'utf8');
            assert.doesNotMatch(text, /\.(pushIndex|loadIndex|loadIndexes|createIndex|createIndexFromFiles|createWebSource)\s*\(/, name);
            assert.doesNotMatch(text, /autoRefresh|MossInference|inference\.chat/, name);
            assert.doesNotMatch(text, /console\.(log|info|debug)\s*\(/, name);
        }
    });

    it('pins the Moss SDK to exactly 1.21.0', () => {
        const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
            dependencies: Record<string, string>;
        };
        assert.equal(pkg.dependencies['@moss-js/moss'], '1.21.0');
    });
});
