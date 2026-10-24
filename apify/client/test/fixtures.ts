// Realistic responses. Names, addresses, phone numbers and URLs are made up (example.com, 555 numbers).
// The errand fixtures are typed with the Actor's own ErrandResult (a type-only import, so nothing from the
// Actor runs), which makes a change to its types.ts fail `npm run typecheck` here.

import type { ErrandResult as ActorErrandResult } from '../../form-errand/src/types.js';

// ---------- RAG Web Browser Standby items ----------
// Shaped like Output in apify/actor-rag-web-browser src/types.ts (read Oct 24, 2026). The Actor sends
// `text` only when outputFormats includes "text"; the default is markdown only.

export const RAG_LOADED = {
    crawl: {
        httpStatusCode: 200,
        httpStatusMessage: 'OK',
        loadedAt: '2026-10-24T18:02:11.482Z',
        requestStatus: 'handled',
        uniqueKey: 'https://cafe.example.com/hours',
    },
    metadata: {
        title: 'Corner Cafe: hours and menu',
        url: 'https://cafe.example.com/hours',
        canonicalUrl: 'https://cafe.example.com/hours',
        redirectedUrl: 'https://cafe.example.com/hours',
        description: 'Open daily from 7 am to 7 pm.',
        languageCode: 'en',
    },
    searchResult: {
        rank: 1,
        title: 'Corner Cafe | Hours',
        description: 'Open daily from 7 am to 7 pm.',
        url: 'https://cafe.example.com/hours',
        resultType: 'ORGANIC',
    },
    markdown: '# Corner Cafe\n\nOpen daily from 7 am to 7 pm. Step-free entrance on the side street.',
    text: 'Corner Cafe Open daily from 7 am to 7 pm. Step-free entrance on the side street.',
    query: 'is the corner cafe open late',
};

/** A page the server gave up on when requestTimeoutSecs ran out (sendResponseError in src/responses.ts). */
export const RAG_TIMED_OUT = {
    crawl: {
        createdAt: '2026-10-24T18:01:50.120Z',
        httpStatusCode: 500,
        httpStatusMessage: 'Timed out.',
        requestStatus: 'failed',
        uniqueKey: 'https://slow.example.org/cafes',
    },
    metadata: { url: 'https://slow.example.org/cafes', title: '' },
    searchResult: {
        rank: 2,
        title: 'Best cafes near campus',
        description: 'A list of cafes.',
        url: 'https://slow.example.org/cafes',
        resultType: 'ORGANIC',
    },
    text: '',
};

export const RAG_NOT_FOUND = {
    crawl: {
        httpStatusCode: 404,
        httpStatusMessage: 'OK',
        loadedAt: '2026-10-24T18:02:12.001Z',
        requestStatus: 'handled',
        uniqueKey: 'https://old.example.net/menu',
    },
    metadata: { title: 'Not found', url: 'https://old.example.net/menu', languageCode: 'en' },
    searchResult: { rank: 3, title: 'Old menu', description: '', url: 'https://old.example.net/menu', resultType: 'ORGANIC' },
    markdown: 'Page not found',
    query: 'is the corner cafe open late',
};

export const RAG_EMPTY = {
    crawl: {
        httpStatusCode: 200,
        httpStatusMessage: 'OK',
        loadedAt: '2026-10-24T18:02:12.300Z',
        requestStatus: 'handled',
        uniqueKey: 'https://app.example.com/',
    },
    metadata: { title: 'App', url: 'https://app.example.com/', languageCode: 'en' },
    searchResult: { rank: 4, title: 'App', description: '', url: 'https://app.example.com/', resultType: 'ORGANIC' },
    markdown: '   ',
    query: 'is the corner cafe open late',
};

const longParagraph = 'The reading room stays open late on weekdays and closes early on Sundays. ';
export const RAG_LONG = {
    crawl: {
        httpStatusCode: 200,
        httpStatusMessage: 'OK',
        loadedAt: '2026-10-24T18:02:13.700Z',
        requestStatus: 'handled',
        uniqueKey: 'https://library.example.edu/hours',
    },
    metadata: { title: '', url: 'https://library.example.edu/hours', languageCode: 'en' },
    searchResult: { rank: 5, title: 'Library hours', description: '', url: 'https://library.example.edu/hours', resultType: 'ORGANIC' },
    markdown: longParagraph.repeat(400),
    query: 'is the corner cafe open late',
};

// ---------- Google Maps Scraper dataset items ----------
// Fields as listed in the Actor's README (compass/crawler-google-places), trimmed with `fields`.

export const PLACE_OPEN = {
    title: 'Corner Cafe',
    address: '100 Example St, Berkeley, CA 94704',
    location: { lat: 37.8688, lng: -122.2595 },
    totalScore: 4.6,
    reviewsCount: 1520,
    wasOpenAtScrapeTime: true,
    permanentlyClosed: false,
    temporarilyClosed: false,
    categoryName: 'Coffee shop',
    phone: '(510) 555-0100',
    url: 'https://www.google.com/maps/search/?api=1&query=Corner%20Cafe&query_place_id=ChIJexample0000001',
    placeId: 'ChIJexample0000001',
    scrapedAt: '2026-10-24T18:05:00.000Z',
    additionalInfo: {
        Accessibility: [{ 'Wheelchair accessible entrance': true }, { 'Wheelchair accessible seating': true }],
        'Service options': [{ 'Dine-in': true }],
    },
};

/** Open state unknown, temporarily closed, and the entrance explicitly listed as not accessible. */
export const PLACE_UNKNOWN = {
    title: 'Noodle Bar.',
    address: '200 Example Ave, Berkeley, CA 94704',
    location: { lat: 37.8701, lng: -122.2681 },
    totalScore: 4.1,
    reviewsCount: 1,
    wasOpenAtScrapeTime: null,
    permanentlyClosed: false,
    temporarilyClosed: true,
    categoryName: 'Noodle shop',
    phone: '(510) 555-0101',
    url: 'https://www.google.com/maps/search/?api=1&query=Noodle%20Bar&query_place_id=ChIJexample0000002',
    placeId: 'ChIJexample0000002',
    scrapedAt: '2026-10-24T18:05:00.000Z',
    additionalInfo: { Accessibility: [{ 'Wheelchair accessible entrance': false }] },
};

export const PLACE_GONE = {
    title: 'Old Diner',
    address: '300 Example Rd, Berkeley, CA 94704',
    location: { lat: 37.871, lng: -122.27 },
    totalScore: 3.9,
    reviewsCount: 88,
    wasOpenAtScrapeTime: false,
    permanentlyClosed: true,
    temporarilyClosed: false,
    categoryName: 'Diner',
    placeId: 'ChIJexample0000003',
    scrapedAt: '2026-10-24T18:05:00.000Z',
};

/** No rating yet, closed at fetch time, and only an accessible-seating entry (not the entrance). */
export const PLACE_SEATING_ONLY = {
    title: 'Taco Window',
    address: '400 Example Way, Berkeley, CA 94704',
    location: { lat: 37.8665, lng: -122.2601 },
    totalScore: 0,
    reviewsCount: 0,
    wasOpenAtScrapeTime: false,
    permanentlyClosed: false,
    temporarilyClosed: false,
    categoryName: 'Taco restaurant',
    placeId: 'ChIJexample0000004',
    scrapedAt: '2026-10-24T18:05:00.000Z',
    additionalInfo: { Accessibility: [{ 'Wheelchair accessible seating': true }] },
};

/** The fewest fields a row can be built from. */
export const PLACE_BARE = { title: 'Pop-up Kiosk', placeId: 'ChIJexample0000005' };

// ---------- form-errand results ----------
// PREVIEWED is the Actor's real local run on its built-in demo form (storage/.../OUTPUT.json), with the
// local screenshot path replaced by an Apify-style URL and an inline screenshot added as Standby returns it.

export const PREVIEWED: ActorErrandResult = {
    status: 'previewed',
    mode: 'preview',
    formUrl: 'demo',
    finalUrl: 'demo',
    formTitle: 'Care team request',
    fillAllowed: true,
    questions: [
        { label: 'What do you need?', kind: 'choice', required: true, options: ['Ride', 'Meal or drink', 'Company', 'Something else'] },
        { label: 'How urgent?', kind: 'choice', required: false, options: ['Now', 'Today', 'This week'] },
        { label: 'Who is this from?', kind: 'text', required: true },
        { label: 'Details', kind: 'paragraph', required: false },
        { label: 'When?', kind: 'text', required: false },
    ],
    readBack: [
        { label: 'Who is this from?', value: 'Demo user', matchedBy: 'label', source: 'memory' },
        { label: 'What do you need?', value: 'Meal or drink', matchedBy: 'group' },
        {
            label: 'Details',
            value: 'Lunch at the cafe across the street.\n\nSent with an assistive switch after a spoken read-back and a confirm.',
            matchedBy: 'label',
        },
        { label: 'When?', value: '12:30 today', matchedBy: 'label' },
        { label: 'How urgent?', value: 'Today', matchedBy: 'group' },
    ],
    readBackText:
        'To Care team request. Who is this from: Demo user. What do you need: Meal or drink. Details: Lunch at the cafe across the street, plus a note saying how it was sent. When: 12:30 today. How urgent: Today. Confirm to send.',
    previewDigest: '3172ba2e39fc4791',
    unmatched: [],
    missingRequired: [],
    refusal: null,
    confirmationText: null,
    screenshotKey: 'SCREENSHOT-PREVIEW-3172ba2e39fc4791',
    screenshotUrl: 'https://api.apify.com/v2/key-value-stores/STORE_ID/records/SCREENSHOT-PREVIEW-3172ba2e39fc4791',
    screenshotBase64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==',
    timings: { loadMs: 650, fillMs: 932, submitMs: null, totalMs: 2928 },
    submittedAt: null,
};

export const SUBMITTED: ActorErrandResult = {
    ...PREVIEWED,
    status: 'submitted',
    mode: 'submit',
    confirmationText: 'Your request was received.',
    screenshotKey: 'SCREENSHOT-CONFIRMATION-3172ba2e39fc4791',
    screenshotUrl: 'https://api.apify.com/v2/key-value-stores/STORE_ID/records/SCREENSHOT-CONFIRMATION-3172ba2e39fc4791',
    timings: { loadMs: 610, fillMs: 880, submitMs: 1405, totalMs: 3301 },
    submittedAt: '2026-10-24T18:10:02.000Z',
};

/** What the Actor's Standby server sends with HTTP 400 for invalid input (inputErrorResult in src/main.ts). */
export const BAD_INPUT: ActorErrandResult = {
    status: 'refused',
    mode: 'submit',
    formUrl: 'demo',
    finalUrl: null,
    formTitle: null,
    fillAllowed: false,
    questions: [],
    readBack: [],
    readBackText: null,
    previewDigest: null,
    unmatched: [],
    missingRequired: [],
    refusal: { code: 'bad_input', reason: 'The errand request was not valid, so nothing was done. fields[0].label is empty.' },
    confirmationText: null,
    screenshotKey: null,
    screenshotUrl: null,
    timings: { loadMs: null, fillMs: null, submitMs: null, totalMs: 0 },
    submittedAt: null,
};

export const CAPTCHA_REFUSED: ActorErrandResult = {
    ...BAD_INPUT,
    mode: 'preview',
    formUrl: 'https://forms.example.com/f',
    finalUrl: 'https://forms.example.com/f',
    refusal: { code: 'captcha', reason: 'This form has a CAPTCHA. I never get past those, so it needs a person.' },
};

/** The send click failed partway (runErrand in the Actor's src/errand.ts): the form may have gone out. */
export const CLICK_UNCERTAIN: ActorErrandResult = {
    ...SUBMITTED,
    status: 'failed',
    confirmationText: null,
    submittedAt: null,
    refusal: { code: 'click_uncertain', reason: 'I may have sent it. Check before trying again.' },
};

export const NO_CONFIRMATION: ActorErrandResult = {
    ...CLICK_UNCERTAIN,
    refusal: { code: 'no_confirmation', reason: 'I pressed send but did not see a confirmation. Check before trying again.' },
};

/** A repeat of a digest whose first send was confirmed. */
export const CONFIRMED_DUPLICATE: ActorErrandResult = { ...SUBMITTED, status: 'duplicate' };

/** A repeat of a digest whose first send has no confirmation on record. */
export const UNCONFIRMED_DUPLICATE: ActorErrandResult = { ...SUBMITTED, status: 'duplicate', confirmationText: null };
