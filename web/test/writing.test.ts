/**
 * A guard for the team's writing rules across web/: plain words, NeuroLingo as the product name,
 * D11 command names, and no claim that the app reads thoughts. It walks the source files, so a new
 * screen is checked the moment it exists, committed or not. Run it with `npm test`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';

const ROOT = process.cwd();
const SELF = join('test', 'writing.test.ts');
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', '.git']);
const SKIP_FILES = new Set(['package-lock.json', 'next-env.d.ts']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.md', '.json']);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), found);
    } else if (EXTENSIONS.has(extname(entry.name)) && !SKIP_FILES.has(entry.name)) {
      found.push(relative(ROOT, join(dir, entry.name)));
    }
  }
  return found;
}

const BANNED_WORDS =
  /\b(robust|seamless(ly)?|leverag(e|es|ed|ing)|comprehensive|powerful|sophisticated|elevat(e|es|ed|ing)|empower(s|ed|ing)?|intuitive|cutting-edge|revolutionary|amazing|effortless(ly)?|streamlin(e|es|ed|ing)|unlocked|ecosystem|easily|simply|delv(e|es|ed|ing))\b/i;
const TRANSFORM = /\btransform(s|ed|ing|ation)?\b/gi;
// Built from code points, so this file holds no dash or curly quote itself: en dash, em dash, and the four curly quotes.
const TYPOGRAPHIC = [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((code) => String.fromCharCode(code));
const DASHES_AND_CURLY_QUOTES = new RegExp(`[${TYPOGRAPHIC.join('')}]`);
const OLD_NAME = /Say When/;
const OLD_COMMANDS = /\b(SELECT|ERRAND|CALL|PAUSE)\b/;
const MIND_CLAIMS = /\b(reads?|reading)\s+(your\s+|their\s+|the\s+person's\s+|a\s+person's\s+)?(thoughts|minds?)\b|\b(mind|thought)[- ]reading\b/i;

/** Every rule a line breaks. `path` decides the CSS and test exceptions. */
function problemsIn(text: string, path: string): string[] {
  const problems: string[] = [];
  const isCss = path.endsWith('.css');
  const isTest = path.startsWith(`test${sep}`) || path.startsWith('test/');
  text.split('\n').forEach((line, i) => {
    const where = `${path}:${i + 1}`;
    if (DASHES_AND_CURLY_QUOTES.test(line)) problems.push(`${where} has an en dash, em dash or curly quote`);
    const banned = BANNED_WORDS.exec(line);
    if (banned) problems.push(`${where} uses "${banned[0]}"`);
    if (!isCss) {
      for (const match of line.matchAll(TRANSFORM)) {
        const before = line.slice(0, match.index);
        const after = line.slice((match.index ?? 0) + match[0].length);
        // A CSS property or value inside code is fine: transform: ..., 'transform 150ms', text-transform.
        const isCode = /^\s*:/.test(after) || /['"`]$/.test(before) || /text-$/.test(before);
        if (!isCode) problems.push(`${where} uses "${match[0]}"`);
      }
    }
    if (OLD_NAME.test(line)) problems.push(`${where} says the old product name; use NeuroLingo`);
    // Tests may name the retired commands to prove they are rejected; SQL in a test fixture is fine too.
    if (!isTest && OLD_COMMANDS.test(line)) problems.push(`${where} uses a retired command name; use YES, NO, CONFIRM or STOP`);
    if (MIND_CLAIMS.test(line)) problems.push(`${where} claims the app reads thoughts or minds`);
  });
  return problems;
}

describe('writing rules across web/', () => {
  const files = walk(ROOT).filter((file) => file !== SELF);

  test('the guard walks the whole app, not an empty folder', () => {
    assert.ok(readFileSync(join(ROOT, 'package.json'), 'utf8').includes('"@say-when/web"'), 'run from web/');
    assert.ok(files.length >= 50, `walked ${files.length} files`);
    for (const must of ['README.md', join('lib', 'data', 'replay.ts'), join('components', 'shell', 'Shell.tsx'), join('app', 'layout.tsx')]) {
      assert.ok(files.includes(must), `walked ${must}`);
    }
  });

  test('the guard catches what it should and passes what it should', () => {
    const emDash = String.fromCharCode(0x2014);
    const bad = problemsIn(`A seamless ${emDash} robust thing. Say When. It reads your thoughts.\nconst x = "SELECT";\nWe transform lives.`, 'lib/x.ts');
    for (const mark of TYPOGRAPHIC) assert.ok(problemsIn(`a${mark}b`, 'lib/x.ts').length === 1, `catches U+${mark.charCodeAt(0).toString(16)}`);
    assert.ok(bad.some((p) => p.includes('en dash')));
    assert.ok(bad.some((p) => p.includes('"seamless"')));
    assert.ok(bad.some((p) => p.includes('old product name')));
    assert.ok(bad.some((p) => p.includes('reads thoughts')));
    assert.ok(bad.some((p) => p.includes('retired command')));
    assert.ok(bad.some((p) => p.includes('"transform"')));
    const fine = [
      "const style = { transform: 'translateY(7px)', transition: 'transform 150ms' };",
      '.x { text-transform: none; transform: none; }',
      'YES picks, NO skips, CONFIRM sends, STOP cancels. The package is @say-when/web.',
    ].join('\n');
    assert.deepEqual(problemsIn(fine, 'lib/y.tsx'), []);
    assert.deepEqual(problemsIn('const q = "SELECT * FROM question";', `test${sep}z.test.ts`), []);
  });

  test('no file breaks a rule', () => {
    const problems = files.flatMap((file) => problemsIn(readFileSync(join(ROOT, file), 'utf8'), file));
    assert.deepEqual(problems, []);
  });
});
