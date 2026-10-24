import type { Browser, Locator, Page } from 'playwright';

import { startDemoServer, type DemoServer } from './demo-form.js';
import { buildReadBackText, computeDigest, normalizeText } from './digest.js';
import { fillField, findMissingRequired, formTitle, listQuestions, locateField, readField, type LocatedField } from './fields.js';
import { checkPage, checkUrl, hasOptInMarker, matchesAllowedPrefix, refusal } from './guards.js';
import type { SubmitLedger } from './ledger.js';
import { HostPolicy, NetworkGuard } from './network.js';
import type { ErrandInput, ErrandResult, FieldInput, ReadBackItem, Refusal } from './types.js';

export interface ScreenshotSink {
    /** Stores a JPEG and returns a URL for it, or null when there is nowhere public to put it. */
    save(key: string, jpeg: Buffer): Promise<string | null>;
}

export interface ErrandDeps {
    browser: Browser;
    ledger: SubmitLedger;
    screenshots: ScreenshotSink;
    /** Operator allowlist from ALLOWED_FORM_PREFIXES. A form also qualifies through the owner's opt-in marker. */
    allowedPrefixes: string[];
    /** Lets tests open http://127.0.0.1 forms. Never set in production. */
    allowLocal: boolean;
    log?: (message: string) => void;
    /** Tests only: shorter limits for the send click and the confirmation wait. */
    timeouts?: { clickMs?: number; confirmMs?: number };
}

const NAV_TIMEOUT_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 20_000;

function emptyResult(input: ErrandInput): ErrandResult {
    return {
        status: 'failed',
        mode: input.mode,
        formUrl: input.formUrl,
        finalUrl: null,
        formTitle: null,
        fillAllowed: false,
        questions: [],
        readBack: [],
        readBackText: null,
        previewDigest: null,
        unmatched: [],
        missingRequired: [],
        refusal: null,
        confirmationText: null,
        screenshotKey: null,
        screenshotUrl: null,
        timings: { loadMs: null, fillMs: null, submitMs: null, totalMs: 0 },
        submittedAt: null,
    };
}

async function pageLines(page: Page): Promise<string[]> {
    const body = await page
        .locator('body')
        .innerText({ timeout: 2_000 })
        .catch(() => '');
    return body
        .split('\n')
        .map((line) => normalizeText(line))
        .filter(Boolean);
}

/** Finds the send button without clicking it. Null when there is none or the lookup itself failed. */
async function findSubmitButton(page: Page, text: string): Promise<Locator | null> {
    const options = [
        page.getByRole('button', { name: text, exact: true }),
        page.getByRole('button', { name: text }),
        page.locator('button[type=submit], input[type=submit]'),
    ];
    try {
        for (const option of options) {
            if ((await option.count()) > 0) return option.first();
        }
    } catch {
        // Nothing has been clicked yet, so a failed lookup is the same as no button.
    }
    return null;
}

/** Longest confirmation text returned; the whole line is still what gets compared. */
const CONFIRMATION_CHARS = 300;

/**
 * Waits for a line containing one of the phrases that was not on the page before the click. Whole lines are
 * compared with the whole lines from before, and only the line returned is cut, so a long line that was
 * already there can never pass for a new one.
 */
async function waitForConfirmation(page: Page, before: Set<string>, phrases: string[], timeoutMs: number): Promise<string | null> {
    const wanted = phrases.map((p) => p.toLowerCase());
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const fresh = (await pageLines(page)).find((line) => !before.has(line) && wanted.some((p) => line.toLowerCase().includes(p)));
        if (fresh) return fresh.slice(0, CONFIRMATION_CHARS);
        await page.waitForTimeout(250);
    }
    return null;
}

const PRIVATE_NETWORK = 'The page tried to reach a private network address.';

/**
 * Runs one errand: inspect lists the questions, preview fills and reads back without sending,
 * submit sends only after a confirm whose digest still matches the page.
 */
export async function runErrand(input: ErrandInput, deps: ErrandDeps): Promise<ErrandResult> {
    const started = Date.now();
    const log = deps.log ?? (() => undefined);
    const result = emptyResult(input);
    const done = (): ErrandResult => {
        result.timings.totalMs = Date.now() - started;
        return result;
    };
    const refuse = (r: Refusal): ErrandResult => {
        result.status = 'refused';
        result.refusal = r;
        log(`refused: ${r.code}`);
        return done();
    };

    const isDemo = input.formUrl === 'demo';
    if (!isDemo) {
        const bad = checkUrl(input.formUrl, { allowLocal: deps.allowLocal });
        if (bad) return refuse(bad);
    }

    let demo: DemoServer | null = null;
    const context = await deps.browser.newContext({
        viewport: { width: 1000, height: 1300 },
        locale: 'en-US',
        acceptDownloads: false,
        // A service worker could make requests our routes never see.
        serviceWorkers: 'block',
    });
    // Bundlers that keep function names (esbuild, used by tsx) wrap functions in __name(); functions we run
    // inside the page carry that call with them, so give the page a no-op __name.
    await context.addInitScript({ content: 'window.__name = window.__name || function (fn) { return fn; };' });
    // Only public hosts, checked before each request and again after redirects, which routes do not see.
    const guard = new NetworkGuard(new HostPolicy(deps.allowLocal || isDemo));
    await guard.attach(context);
    try {
        if (isDemo) demo = await startDemoServer();
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);

        const loadStart = Date.now();
        try {
            const response = await page.goto(demo ? demo.url : input.formUrl, {
                waitUntil: 'domcontentloaded',
                timeout: NAV_TIMEOUT_MS,
            });
            if (response && response.status() >= 400) return refuse(refusal('load_failed', `The page answered ${response.status()}.`));
        } catch {
            if (!(await guard.clean(page))) return refuse(refusal('bad_url', PRIVATE_NETWORK));
            return refuse(refusal('load_failed'));
        }
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        result.timings.loadMs = Date.now() - loadStart;
        if (!(await guard.clean(page))) return refuse(refusal('bad_url', PRIVATE_NETWORK));
        if (!isDemo) {
            // Redirects can move us; the page we actually fill must pass the same address rules.
            const movedBad = checkUrl(page.url(), { allowLocal: deps.allowLocal });
            if (movedBad) return refuse(movedBad);
        }
        result.finalUrl = demo ? 'demo' : page.url();

        const blocked = await checkPage(page);
        if (blocked) return refuse(blocked);

        result.formTitle = await formTitle(page);
        result.questions = await listQuestions(page);
        result.fillAllowed =
            isDemo || matchesAllowedPrefix(page.url(), deps.allowedPrefixes) || (await hasOptInMarker(page));

        if (input.mode === 'inspect') {
            result.status = 'inspected';
            return done();
        }
        if (!result.fillAllowed) return refuse(refusal('not_allowed'));

        // Fill every answer, then read each value back off the page.
        const fillStart = Date.now();
        const filled: Array<{ input: FieldInput; field: LocatedField }> = [];
        const seen = new Set<string>();
        for (const answer of input.fields) {
            const key = normalizeText(answer.label).toLowerCase();
            if (seen.has(key)) {
                result.unmatched.push(`${answer.label} (listed twice)`);
                continue;
            }
            seen.add(key);
            const field = await locateField(page, answer.label);
            if (!field) {
                result.unmatched.push(`${answer.label} (no such question)`);
                continue;
            }
            const error = await fillField(field, answer.value).catch((e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : 'fill failed'));
            if (error) result.unmatched.push(`${answer.label} (${error})`);
            else filled.push({ input: answer, field });
        }

        // Append the disclosure to one free-text answer so the recipient knows how this was sent.
        let disclosureLabel: string | undefined;
        if (input.disclosureText) {
            const paragraphs = filled.filter((f) => f.field.kind === 'paragraph');
            const target = input.disclosureField
                ? paragraphs.find((f) => normalizeText(f.input.label) === normalizeText(input.disclosureField ?? ''))
                : paragraphs[paragraphs.length - 1];
            if (target) {
                const current = await readField(target.field);
                if (!current.endsWith(input.disclosureText)) {
                    await fillField(target.field, current ? `${current}\n\n${input.disclosureText}` : input.disclosureText);
                }
                disclosureLabel = target.input.label;
            }
        }

        const readBack: ReadBackItem[] = [];
        for (const { input: answer, field } of filled) {
            readBack.push({
                label: answer.label,
                value: await readField(field),
                matchedBy: field.matchedBy,
                ...(answer.source ? { source: answer.source } : {}),
            });
        }
        result.readBack = readBack;
        result.missingRequired = await findMissingRequired(page);
        result.previewDigest = computeDigest(input.formUrl, readBack);
        result.readBackText = buildReadBackText(result.formTitle, readBack, {
            disclosureLabel,
            disclosureText: input.disclosureText || undefined,
        });
        result.timings.fillMs = Date.now() - fillStart;

        const shoot = async (phase: 'PREVIEW' | 'CONFIRMATION'): Promise<void> => {
            // Freeze the network so nothing loads between the check and the capture, then check again
            // after capturing and discard the image if anything private was reached in between.
            guard.freeze();
            if (!(await guard.clean(page))) return;
            const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
            if (!(await guard.clean(page))) return;
            const key = `SCREENSHOT-${phase}-${result.previewDigest ?? 'none'}`;
            result.screenshotKey = key;
            result.screenshotUrl = await deps.screenshots.save(key, jpeg).catch(() => null);
            if (input.includeScreenshot) result.screenshotBase64 = jpeg.toString('base64');
        };

        if (!(await guard.clean(page))) return refuse(refusal('bad_url', PRIVATE_NETWORK));
        if (input.mode === 'preview') {
            await shoot('PREVIEW');
            result.status = 'previewed';
            log(`previewed ${readBack.length} answers, ${result.unmatched.length} unmatched`);
            return done();
        }

        // Submit: every gate must pass, in this order, before anything is clicked.
        if (!input.confirm) return refuse(refusal('not_confirmed'));
        if (result.unmatched.length > 0) return refuse(refusal('unmatched_fields'));
        if (result.missingRequired.length > 0) {
            return refuse(refusal('missing_required', `Empty: ${result.missingRequired.join(', ')}.`));
        }
        if (!input.confirmDigest || input.confirmDigest !== result.previewDigest) return refuse(refusal('digest_mismatch'));

        const claim = await deps.ledger.claim(input.formUrl, result.previewDigest);
        if (claim.duplicate) {
            result.status = 'duplicate';
            result.confirmationText = claim.previous.confirmationText;
            result.submittedAt = claim.previous.at;
            log('duplicate submit refused');
            return done();
        }

        const submitStart = Date.now();
        const before = new Set(await pageLines(page));
        // The only case that may release the claim and say nothing was sent: no button, so no click.
        const button = await findSubmitButton(page, input.submitButtonText);
        if (!button) {
            await deps.ledger.release(claim.key);
            return refuse(refusal('no_submit_button'));
        }
        // Sending needs the network for the POST and the confirmation page; the guard still applies.
        guard.thaw();
        // From the click on, the form may have been sent, so the claim is kept whatever happens.
        let clickFailed = false;
        try {
            await button.click(deps.timeouts?.clickMs ? { timeout: deps.timeouts.clickMs } : {});
        } catch {
            // A click can throw after it was delivered, for example while the navigation it started never
            // finishes. Still look for a confirmation, and never report this as "not sent".
            clickFailed = true;
        }
        const confirmation = await waitForConfirmation(
            page,
            before,
            input.confirmationPhrases,
            deps.timeouts?.confirmMs ?? CONFIRM_TIMEOUT_MS,
        ).catch(() => null);
        result.timings.submitMs = Date.now() - submitStart;
        await shoot('CONFIRMATION').catch(() => undefined);

        if (!confirmation) {
            await deps.ledger.finish(claim.key, 'unconfirmed', null);
            result.status = 'failed';
            result.refusal = refusal(clickFailed ? 'click_uncertain' : 'no_confirmation');
            log(clickFailed ? 'submit click failed partway, outcome unknown' : 'submit clicked, no confirmation seen');
            return done();
        }
        await deps.ledger.finish(claim.key, 'submitted', confirmation);
        result.status = 'submitted';
        result.confirmationText = confirmation;
        result.submittedAt = new Date().toISOString();
        log('submitted');
        return done();
    } finally {
        await context.close().catch(() => undefined);
        if (demo) await demo.close();
    }
}
