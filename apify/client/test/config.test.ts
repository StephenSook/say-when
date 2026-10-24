import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, DEFAULT_RAG_WEB_BROWSER_URL, loadConfig } from '../src/config.js';
import { TOKEN } from './fake-fetch.js';

const configError = (pattern: RegExp) => (e: unknown) => e instanceof ConfigError && pattern.test(e.message);

describe('loadConfig', () => {
    it('reads the token and fills in the RAG Web Browser default', () => {
        const config = loadConfig({ APIFY_TOKEN: TOKEN });
        assert.equal(config.token, TOKEN);
        assert.equal(config.ragWebBrowserUrl, DEFAULT_RAG_WEB_BROWSER_URL);
        assert.equal(config.formErrandUrl, undefined);
    });

    it('names APIFY_TOKEN when it is missing or empty', () => {
        assert.throws(() => loadConfig({}), configError(/APIFY_TOKEN/));
        assert.throws(() => loadConfig({ APIFY_TOKEN: '  ' }), configError(/APIFY_TOKEN/));
    });

    it('refuses a token with spaces or line breaks without echoing it', () => {
        assert.throws(
            () => loadConfig({ APIFY_TOKEN: `${TOKEN} ${TOKEN}` }),
            (e: unknown) => e instanceof ConfigError && /APIFY_TOKEN/.test(e.message) && !e.message.includes(TOKEN),
        );
    });

    it('treats empty optional values as unset', () => {
        const config = loadConfig({ APIFY_TOKEN: TOKEN, FORM_ERRAND_URL: '', RAG_WEB_BROWSER_URL: '' });
        assert.equal(config.formErrandUrl, undefined);
        assert.equal(config.ragWebBrowserUrl, DEFAULT_RAG_WEB_BROWSER_URL);
    });

    it('normalizes base URLs and accepts the full /search endpoint', () => {
        const config = loadConfig({
            APIFY_TOKEN: TOKEN,
            FORM_ERRAND_URL: 'https://someone--confirm-gated-form-errand.apify.actor/',
            RAG_WEB_BROWSER_URL: 'https://rag-web-browser.apify.actor/search',
        });
        assert.equal(config.formErrandUrl, 'https://someone--confirm-gated-form-errand.apify.actor');
        assert.equal(config.ragWebBrowserUrl, 'https://rag-web-browser.apify.actor');
    });

    it('allows plain http only for this machine', () => {
        assert.equal(loadConfig({ APIFY_TOKEN: TOKEN, FORM_ERRAND_URL: 'http://127.0.0.1:4321' }).formErrandUrl, 'http://127.0.0.1:4321');
        assert.throws(() => loadConfig({ APIFY_TOKEN: TOKEN, FORM_ERRAND_URL: 'http://errand.example.com' }), configError(/FORM_ERRAND_URL/));
    });

    it('refuses a URL carrying a token or credentials, without echoing it', () => {
        const pasted = `https://someone--confirm-gated-form-errand.apify.actor/?token=${TOKEN}`;
        assert.throws(
            () => loadConfig({ APIFY_TOKEN: TOKEN, FORM_ERRAND_URL: pasted }),
            (e: unknown) => e instanceof ConfigError && /FORM_ERRAND_URL/.test(e.message) && !e.message.includes(TOKEN),
        );
        assert.throws(() => loadConfig({ APIFY_TOKEN: TOKEN, RAG_WEB_BROWSER_URL: 'https://user:pw@rag.example.com' }), configError(/RAG_WEB_BROWSER_URL/));
        assert.throws(() => loadConfig({ APIFY_TOKEN: TOKEN, RAG_WEB_BROWSER_URL: 'not a url' }), configError(/RAG_WEB_BROWSER_URL/));
    });
});
