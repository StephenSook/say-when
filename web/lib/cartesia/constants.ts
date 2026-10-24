// Checked on Oct 24, 2026 against docs.cartesia.ai for API version 2026-08-14. Sources are listed in README.md.

export const CARTESIA_API_BASE = 'https://api.cartesia.ai';
export const CARTESIA_WS_BASE = 'wss://api.cartesia.ai';

/** The only value the 2026-08-14 reference allows, sent as the Cartesia-Version header or the cartesia_version query. */
export const CARTESIA_VERSION = '2026-08-14';

/** Listed in the TTS WebSocket schema enum; tracks the latest stable Sonic 3.6 snapshot. */
export const SONIC_MODEL = 'sonic-3.6';

/**
 * Dated snapshot from the Sonic 3.6 models page and the caching guide. It is not in the WebSocket schema enum,
 * so try it once on the live API before pinning cached clips to it.
 */
export const SONIC_SNAPSHOT = 'sonic-3.6-2026-08-27';

/** Speech to text model for the turns WebSocket. */
export const INK_MODEL = 'ink-2';
