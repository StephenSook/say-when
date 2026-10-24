import { chromium, type Browser } from 'playwright';

/**
 * One headless Chromium for the whole run. PLAYWRIGHT_CHANNEL=chrome uses an installed Google Chrome,
 * which is handy on a laptop without Playwright's own browser download.
 */
export async function launchBrowser(): Promise<Browser> {
    const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
    return chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
        args: ['--disable-dev-shm-usage', '--no-first-run'],
    });
}
