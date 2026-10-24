# Say When UI spec

For Stephen, who builds all of the UI. How the dashboard and the partner phone view should look and behave. It is modeled on tube's UI and cut down to what we need.

**Rule zero:** each screen has one obvious focus, a few big labels, and nothing competing with them. If a screen needs a paragraph to explain itself, cut things from the screen.

**See it first:** open `docs/mockups/index.html` in a browser. It has static mockups of all four screens (Live data, Agents at work, Live conversation, Partner phone) built with the tokens below, at desktop and phone width. `docs/mockups/tokens.css` is ready to copy into `web/app/globals.css`. The mockups load Geist from Google Fonts; in Next.js use `next/font/google` instead.

## Summary

Tube puts one large visual in the middle of a near-black page (`#050505`) and keeps every control small and quiet at the edges: a 248 px rail top left, a 296 px results panel top right, a 44 px search pill bottom center. In the main app, text is white at two strengths, 88% for content and 52% for everything secondary, in two weights, 400 and 500. Color goes only to data and state: pastel colors for tracked objects, red `#ff3b30` for the answer, lilac `#c9a0f0` for progress and live input. Lists are rows with a main line over a muted "time · detail" line in tabular numbers. Every state is a plain sentence ("Searching", "Queued, waiting for a worker", "The archive did not answer"). It works because color is rare, so whatever is colored is the answer, and nothing else asks for attention. We keep that discipline, make the type bigger for a room, and leave out the 3D.

## Reference

- Live site: https://tube-kohl.vercel.app (landing `/`, cube app `/app`, archive search `/archive`). Viewed 2026-10-24 UTC at 1440x900 and 390x844.
- Repo: https://github.com/amanibobo/tube. Files were read as data through the GitHub API. Nothing was cloned, installed or run.
- License: **none**. GitHub reports no license, the repo has no LICENSE file, and neither `viewer/package.json` nor `pyproject.toml` declares one. We learn from its patterns and measured values and write our own code. Do not copy its code.
- Screenshots of the live site were taken for this study and are kept privately, outside this repo.
- Caveat: during the visit every request to the archive's backend failed in the browser (CORS errors on `/api/library`), so `/archive` showed only its loading and error states. Its result card is described from `viewer/src/archive/archive.css`, `Archive.tsx` and the repo image `docs/devpost/archive-hit.png`.
- Values below come from tube's source files or from `getComputedStyle` on the live pages. Anything we changed is marked "ours".

## Keep and skip

Keep, because this is what makes tube feel simple:

1. One hero per screen. Everything else is small and at the edges.
2. Two text strengths and two weights (400, 500). No bold, no all caps, no letter spacing.
3. Color only for data and state, never for decoration.
4. Hairlines instead of boxes: 1 px at 14% white. The floating panels in `/app` have no border at all.
5. Text links for secondary actions ("Hide", "Show results", "Cancel"). Real buttons are rare.
6. Rows with a main line and a muted meta line. Numbers in tabular figures, so live values do not jitter.
7. States as plain sentences, and waits whose message changes over time: "Loading the archive" at 0 s, "Waking up the server" at 3 s, "Still starting. The first visit after a while takes up to half a minute." at 10 s (`archive/Loader.tsx`).
8. A step list with four states: done, current, todo, failed (`archive/UploadPanel.tsx`, `.stages` in `archive.css`).
9. Short motion, mostly 150 to 300 ms, with 7 px offsets.

Skip:

1. The 3D cube, WebGL, shaders and grain background. None of our data needs them.
2. Tube's UI text sizes (mostly 11 to 15 px). Too small for a room.
3. Tube's faint gray `#5c5a58` for text. It measures 2.97:1 on `#050505`, which fails WCAG AA.
4. Selection shown only by a 9% white fill (1.20:1), and keyboard focus on rows shown only by a 5% fill (1.09:1). Both vanish on a projector.
5. Controls that appear only on hover or focus (the archive's delete button). Nobody hovers on a projector or a phone.
6. Hiding the whole UI until an intro animation ends (`/app` starts with `railShown: false` in `store.ts`).
7. The `/app` phone layout. At 390 px its search pill shrinks to 62 px and the clear and mic buttons spill out. Cause: in the production build the shared `base.css` chunk loads after the app's own CSS chunk and undoes the phone value of `--free-left`. Lesson: keep each token and its media query in the same file.
8. Sign-in, uploads, quota meters and account menus.

## Stack

| Layer | Tube | Say When |
|---|---|---|
| Framework | Vite 7.3.7, React 19.3.0. No router library: `main.tsx` picks a page from `location.pathname` and lazy loads it | Next.js App Router in `web/`, one route per screen |
| Styling | Plain CSS with custom properties in four files: `base.css`, `styles.css`, `archive/archive.css`, `landing/landing.css`. No Tailwind, no CSS Modules, no component library | Plain CSS. Tokens in `app/globals.css`, one CSS Module per component. No Tailwind, no component kit |
| Fonts | Geist 400 and 500 from a Google Fonts link in `index.html`, used by the landing. `/app` and `/archive` use `-apple-system, BlinkMacSystemFont, 'Inter', 'Helvetica Neue', sans-serif` | Geist 400/500 and Geist Mono 400 through `next/font/google`, so every laptop shows the same face |
| Icons | Hand-drawn inline SVG: 16 px viewBox, 1.3 to 1.6 px stroke, round caps | Same, and as few as possible. Words first |
| Graphics | three 0.186.1, @react-three/fiber 9.8.1, @react-three/drei 10.7.9, @paper-design/shaders-react 0.0.81 | None |
| Animation | No library. CSS transitions and keyframes, a few `requestAnimationFrame` loops | CSS only |
| State | zustand 5.0.15 | SpacetimeDB rows are the state. React state only for view choices (which question, which card is open) |
| Live data | `fetch`, `EventSource` for job progress (`api.ts`), a WebSocket for live speech to text (`archive/voice.ts`), retries with doubling backoff capped at 8 s (`archive/api.ts`) | `spacetimedb/react`: `SpacetimeDBProvider`, `useTable(query)` returns `[rows, isReady]`, `useSpacetimeDB()` returns `isActive` |
| Auth | @auth0/auth0-react 2.28.2 for archive uploads | None. Any laptop, no login (PLAN D7) |

The SpacetimeDB names come from the current TypeScript client docs (spacetimedb.com/docs/clients/typescript). Check them against the 2.13.0 package and our generated bindings. The same docs say cached rows can stay on screen while the connection is down, and that `isActive` and `isReady` are the flags for a connection indicator. The shell below uses exactly those.

## Tokens

Tube does not use Tailwind, so there is no Tailwind mapping. Paste this into `web/app/globals.css`.

```css
/* Values measured from tube unless marked "ours". */
:root {
  color-scheme: dark;

  /* Surfaces */
  --bg: #050505;                              /* base.css --bg */
  --surface: rgba(5, 5, 5, 0.72);             /* base.css --surface: pill, panel */
  --card: #0e0e0f;                            /* archive.css --card */
  --card-border: #3a3a3c;                     /* archive.css .card, .panel, .menu */
  --control-bg: #0a0a0a;                      /* archive.css .chip, .loader-retry, inputs */
  --media-bg: #111111;                        /* styles.css .player video */

  /* Text */
  --fg: rgba(255, 255, 255, 0.88);            /* base.css --fg, 15.6:1 */
  --fg-muted: rgba(255, 255, 255, 0.52);      /* base.css --fg-muted, 5.7:1 */

  /* Lines and fills: decoration only, never the only sign of state */
  --line: rgba(255, 255, 255, 0.14);          /* base.css --line */
  --divider: rgba(255, 255, 255, 0.07);       /* archive.css .panel-head border */
  --hover: rgba(255, 255, 255, 0.05);         /* base.css --hover */
  --active: rgba(255, 255, 255, 0.09);        /* base.css --active */

  /* State */
  --accent: #c9a0f0;                          /* archive.css --lilac: live, now, done */
  --accent-soft: rgba(201, 160, 240, 0.16);   /* archive.css done mark fill */
  --accent-line: rgba(201, 160, 240, 0.45);   /* archive.css pinned card border */
  --wait: #f2c46d;                            /* ours: waiting for the person's confirm */
  --wait-soft: rgba(242, 196, 109, 0.14);     /* ours */
  --error: #d98a8a;                           /* archive.css --error: failed */
  --error-soft: rgba(217, 138, 138, 0.14);    /* ours */
  --highlight: #ff3b30;                       /* scene/space.ts HIGHLIGHT_RED */
  --focus: rgba(255, 255, 255, 0.88);         /* ours */

  /* Type */
  --font-sans: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;  /* ours: digests, ids */
  --weight: 400;
  --weight-strong: 500;                       /* tube never goes above 500 */
  --leading: 1.45;                            /* base.css body */
  --leading-tight: 1.2;                       /* ours: big text */
  --text-meta: 14px;                          /* tube 12px, ours larger */
  --text: 16px;                               /* tube 14px, ours larger */
  --text-title: 20px;                         /* landing.css .lp-name */
  --text-lead: 28px;                          /* ours */
  --text-hero: clamp(32px, 3vw, 48px);        /* ours: question and options */

  /* Space: tube's 4/8/12/16/24, plus two larger steps */
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s6: 24px;
  --s8: 32px;                                 /* ours */
  --s12: 48px;                                /* ours */

  /* Radius */
  --radius: 6px;                              /* controls, rows */
  --radius-card: 8px;                         /* video, /app panel */
  --radius-panel: 10px;                       /* archive card, panel, menu */
  --radius-dialog: 12px;                      /* landing dialog */
  --radius-thumb: 4px;                        /* archive thumbnails */
  --radius-pill: 999px;                       /* search pill, chips */

  /* Elevation and layers */
  --shadow-card: 0 16px 48px rgba(0, 0, 0, 0.6);     /* archive card, panel */
  --shadow-dialog: 0 24px 64px rgba(0, 0, 0, 0.28);  /* landing dialog */
  --backdrop: rgba(0, 0, 0, 0.45);                   /* landing dialog */
  --z-header: 10;                             /* tube uses 10 and 20 */
  --z-banner: 20;
  --z-dialog: 30;

  /* Layout */
  --gutter: 16px;                             /* layout.ts GUTTER */
  --header-h: 56px;                           /* ours */
  --side-w: 320px;                            /* ours: tube rail 248, panel 296 */
  --pill-h: 44px;                             /* layout.ts PILL_HEIGHT */
  --pill-h-phone: 56px;                       /* ours: thumb target */

  /* Motion */
  --dur-fast: 150ms;                          /* .fade-in, pill border */
  --dur-panel: 160ms;                         /* archive panel in and out */
  --dur-row: 240ms;                           /* archive row-in */
  --dur-slow: 300ms;                          /* .ui fade, progress bar */
  --ease-out: cubic-bezier(0.2, 0.7, 0.2, 1); /* archive panel height */
}

/* Phone values live in this same file (Skip, item 7). 720px is tube's NARROW. */
@media (max-width: 720px) {
  :root {
    --text-lead: 22px;
    --text-hero: 28px;
  }
}

html, body { margin: 0; background: var(--bg); color: var(--fg); }
body {
  font: var(--weight) var(--text) / var(--leading) var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.num { font-variant-numeric: tabular-nums; }
```

What we changed, and why:

- Sizes go up (meta 12 to 14 px, body 14 to 16 px) and two big sizes are new. People read this from across a table.
- Tube's `--faint` (`#5c5a58`, 2.97:1) is gone. All secondary text uses `--fg-muted` (5.7:1).
- `--focus` and a real outline are new. Tube's rows hide the outline and show focus as a 5% fill.
- Geist Mono is new, for digests and ids. Tube has no mono face.
- One accent, used the way the archive uses lilac: `--accent` means "happening now" (the scan cursor, the running step, Live) and `--error` means "stopped or failed" (STOP, HEADSET-OFF, a failed step). NO is a normal command and stays white. The cube's ten track colors in `scene/space.ts` (`#dcf26a`, `#ff9ed2`, `#6ef0ff`, `#8ff5c2`, `#c6b3ff`, `#ffc98a`, `#7cc8ff`, `#f2f58a`, `#ff9a8a`, `#86f7e3`) are left out on purpose.

## Patterns from live dashboards

A second study looked at products that show agents, voice calls and live data (Trigger.dev, n8n, Pipecat, Supabase Realtime, Vapi, LiveKit, Skyvern, Browserbase, Apify, Retell, Statuspage) and at switch-scanning software for people who cannot speak (Cboard, TD Snap, Grid 3, Apple Switch Control). These ten patterns are worth copying, and the mockups use them:

1. **Status is an icon shape, a word and a color, never color alone.** (Trigger.dev run status; WCAG 1.4.1.)
2. **Stages run left to right, and the link between two stages shows what passed:** "10 words", "6 rows", "4 hits". (n8n.)
3. **Each stage shows its real payload in one line**, with the full rows one click away, above a raw event feed that has Pause. (Pipecat Whisker, Supabase Realtime Inspector.)
4. **One headline latency number per question**, "2.9 s to the first option", plus the time per stage. (Vapi, LiveKit.)
5. **Each agent gets a numbered step list** with a done, failed or waiting mark and the time. (Skyvern, GitHub Actions.)
6. **Show what the browser agent sees, read-only and labeled** "Preview, not sent". (Browserbase, Apify live view.)
7. **The call panel has a live duration, transcript lines and an end reason** in plain words ("No answer after 30 s"). (Retell, Vapi.)
8. **One plain sentence on top of every screen**, rolled up from the parts: "Waiting for the person to confirm. Nothing has been sent." (Statuspage.)
9. **The scan cursor is a thick outline with a time-left bar.** It waits for the audio to finish before the window opens, and it stops after a set number of passes. (Cboard, Grid 3, TD Snap, Apple.)
10. **Label both audio channels:** "In the earpiece now" for what the person hears privately, "Said out loud" for what the room hears. (TD Snap, Grid 3.)

## Status vocabulary

Use exactly these words everywhere: Live data, Agents, Conversation and the phone.

| State | Meaning | Mark | Color |
|---|---|---|---|
| Not started | no row yet | hollow ring | muted text |
| Working | the step is running | spinner | `--fg` text, `--accent` spinner |
| Waiting for confirm | read-back done, confirm window open | hourglass, plus a countdown bar | `--wait` |
| Done | finished with a result | check | `--accent` |
| Refused | a safety rule said no on purpose (CAPTCHA, login, not opted in) | no-entry sign plus the reason | muted text, not red |
| Stopped | NO, STOP, headset off, or the window ran out; nothing sent | pause or X plus the reason | muted text, not red |
| Failed | something broke | X in a circle plus the reason | `--error` |

- `pipeline_event.status`: `started` is Working, `ok` is Done, `error` is Failed.
- A confirm window that runs out is "Stopped, nothing sent", never a red "Timed out". Silence is the safe outcome, so it must not look like an error.
- Calls: Dialing, Ringing (with a ring timer), Connected (live duration), Ended (with the end reason), No answer, Failed. Cartesia's call status only has created, started, completed and failed, so Ringing and Connected need our own events.

## Layout and components

Wireframe legend: `[v]` done, `[*]` running, `[ ]` not yet, `[x]` failed, `|` the accent bar. Times and counts in the wireframes are layout examples, not measurements.

### Shared shell

```
+------------------------------------------------------------------------------+
| Say When     Live data   Agents   Conversation        (o Live) (Headset on)  |
|                                   ============                               |
+------------------------------------------------------------------------------+
| Paused. Nothing will be sent.                        (only while paused)     |
+------------------------------------------------------------------------------+
|                                                                              |
|                     the screen: one focus, big labels                        |
|                                                                              |
+------------------------------------------------------------------------------+
```

- Header: `--header-h` tall, `--s6` side padding, a `--divider` line under it. "Say When" at `--text-title`, weight 500.
- Tabs: plain links at `--text`. The current one is `--fg` at weight 500 with a 2 px `--fg` underline and `aria-current="page"` (tube's archive tab uses a 1 px underline). Others are `--fg-muted`. Routes: `/live`, `/agents`, `/conversation`, and `/partner` for the phone. Keys 1, 2 and 3 switch screens in PLAN order (tube binds `/`, arrows and Space in `useKeyboard.ts`). Open question for Stephen: should `/` open Conversation, the demo screen?
- Connection chip, driven by `useSpacetimeDB().isActive` and each screen's `useTable` `isReady`:

| State | When | Chip | Screen |
|---|---|---|---|
| Connecting | not active, no rows yet | spinner, "Connecting" | its status line |
| Live | active and ready | 8 px `--accent` dot, "Live" | normal |
| Reconnecting | not active, rows still shown | spinner, "Reconnecting" | content at 60% opacity, one line: "Showing the last known state" |
| Offline | not active for 10 s | "Offline" in `--error` | the line becomes "Not connected. Check the network." |

- Headset chip: "Headset on" in `--fg-muted` by default. On a STOP or HEADSET_OFF command event it turns `--error` and a full-width banner appears under the header: "Paused. Nothing will be sent." or "Headset off. Nothing will be sent." Both cancel anything pending, so the room must see it.
- Under 720 px: name and chips on one row, tabs on a second row.

Shared parts. Build each once and use it everywhere:

| Part | Looks like | Tube source |
|---|---|---|
| Text link | `--fg-muted`, `--fg` on hover and focus, no underline | `.link`, `.lp-link` |
| Row | full width, `--s2` padding, `--radius`. Main line `--fg`, meta line `--fg-muted` at `--text-meta`, tabular numbers. Hover: `--hover`. Current: `--active` fill plus a 3 px `--accent` bar on the left (the bar is ours) | `.row-button` |
| Step list | one line per step: 18 px mark (tube 14), name, time or count on the right. Todo: 1 px ring at 12% white, muted text. Running: spinner, `--fg`. Done: accent check on `--accent-soft`. Failed: ring and text in `--error` | `.stages li[data-state]` |
| Chip | 32 px pill (tube 28), 1 px `--line`, `--control-bg`, `--text-meta`, optional 12 px spinner or 8 px dot | archive `.chip` |
| Card | `--card`, 1 px `--card-border`, `--radius-panel`, `--shadow-card`. Media sits 7 px in, with a 3 px radius | archive `.card` |
| Bar | 2 px track at 10% white, `--accent` fill from the left | archive `.bar`, `/app` `.progress` |
| Spinner | 12 to 14 px ring, 1.5 px `--line` border, top segment `--fg` or `--accent`, 0.8 s linear | `.spinner` |
| Status line | one muted sentence, centered, that changes at 0 s, 3 s and 10 s | archive `Loader.tsx` |
| Pill input | `--pill-h`, `--radius-pill`, `--surface`, 1 px `--line`, border turns `--fg-muted` while focused, icon left, clear right | `.pill` |
| Dialog | native `<dialog>`, `--radius-dialog`, `--shadow-dialog`, `--backdrop`. Esc or a backdrop click closes it | landing `DemoDialog` |

Errors follow tube's habit: one human sentence on screen, the raw error text in a `title` tooltip (`SearchPill.tsx` does this for voice errors).

### Screen 1: Live data (PLAN 5.2, Stephen)

Purpose: show what each pipeline step produced for the current question, and how long it took.

Focus: the step running now (outlined, bright). Finished steps show their payload and time; steps not started are muted. See `docs/mockups/live.html`.

```
 Question 7, asked by the partner                                        2.9 s
 "<partner's words>"                                        to the first option

 [v] Heard  -10 words->  [v] Searched  -6 rows->  [v] Recalled  -4 hits->  [*] Drafting  ->  [ ] Speaking  ->  [ ] Picked
 Cartesia Ink-2          Apify, Maps + web        Moss, memory + web       Claude            Cartesia Sonic     Headset
 "<words>"               <top row>                "<top hit>"              Writing options   Not started        Not started
 0.4 s                   1.8 s                    0.08 s                   0.6 s so far

 Apify found       6 rows from 2 searches  |  Moss recalled          4 hits in 80 ms
 <title>                fetched 12:40:58   |  "<hit text>"                     0.82
 Google Maps, wheelchair entrance listed   |  memory, saved Oct 12
 ...                                       |  ...

 Events, newest first   Pause
 12:41:06  retrieve  ok  81 ms  4 hits
```

- Stages run left to right; under 1100 px wide they stack top to bottom with the counts on the links.
- Every web row shows its source and fetch time, and every Moss hit shows whether it came from memory or the web. That answers a judge's first trust question: where did this come from, and how fresh is it?
- Never mark a stage done without its number (ms, rows or hits).
- Parts: step list with step names at `--text-title` and the tool name as a muted meta line, rows for the payload, a 24 px round play button for the voice clip.
- Rows: `pipeline_event` (`stage`, `status`, `detail`, `ms`, `at`), plus `option` for the Plan step. What each step shows, from `detail`:
  - Listen: the partner's words.
  - Search: Apify rows, each `title` over `source · fetched <time>` (Search client contract).
  - Retrieve: Moss hits, each text over `source · fetched <time>` (Moss doc metadata).
  - Plan: the options for this question, in `rank` order.
  - Speak: which option is being read. Play button only if `detail` has a clip URL.
  - Select, Errand, Call: one line. Errand and Call link to Agents.
- Live: a `started` row turns the mark into a spinner and its time counts up every 250 ms (tube's `useElapsed` ticks at 250 ms). `ok` sets the check and the final `ms`. `error` sets the failed mark. The open step is always the newest one. A new Listen start begins a new question. Left and Right arrows step through earlier questions; a "Back to live" link returns.
- Empty: "Waiting for the partner to ask something." centered, muted.
- Loading: the status line.
- Error: the failed step in `--error` with one sentence. Later steps stay "not yet".

### Screen 2: Agents at work (PLAN 5.3, Stephen)

Purpose: show the form agent and the call agent doing their jobs step by step, so the room sees that nothing leaves without a fresh confirm.

Focus: the agent that is working gets the big card. The other agent is one line at the bottom.

```
 Form errand  <form name>                                    Waiting for CONFIRM
 +------------------------------+
 |                              |   [v] Preview made                  10:42:05
 |      preview screenshot      |   [v] Read back to the person       10:42:09
 |      (click to enlarge)      |   [*] Waiting for a double clench
 |                              |       ==============--------   6 s left
 +------------------------------+   [ ] Sent
 Read back   "<read_back_text>"
 Digest      <first 8 chars>          Confirmation   <confirmation_text>

 Phone call   not started
```

```
 Phone call  <contact name>                                     Connected  0:42
 [v] Prepared                      Assistant   "<line>"
 [v] Ringing                       <name>      "<line>"
 [*] Connected                     Assistant   "<line>"
 [ ] Ended
```

- Parts: card with the preview screenshot (a click opens the dialog), step list, rows for the transcript, digest in `--font-mono`.
- Rows: `errand` (`form`, `status`, `preview_digest`, `read_back_text`, `confirmation_text`, `screenshot_url`), `call_request` (`contact`, `script_digest`, `status`), and the command event that released or stopped each one.
- Errand steps: Preview made (`screenshot_url` set), Read back (`read_back_text` set), Waiting for CONFIRM, a double jaw clench (row awaits confirmation), Sent (`confirmation_text` set). A NO, a timeout, PAUSE or HEADSET-OFF fails the waiting step with "Not sent: <reason>".
- Call steps: Prepared (`script_digest` set), Ringing, Connected, Ended, from `status`.
- The countdown bar shows only if the row says when the confirm window closes. That field is not in the draft contract.
- Show the contact's name only. Never show a phone number on a projected screen. Digest: first 8 characters, the full value in a tooltip.
- Live: marks update as fields fill in. The screenshot fades in when it loads (tube's archive thumbnails fade in over 250 ms). Transcript lines enter at the bottom (240 ms). The label at top right is always the current state in words.
- Empty: "No errand or call yet. Errands and calls are offered as options, or from the person's menu. Nothing is sent without a double jaw clench."
- Loading: the status line.
- Error: the failed step in `--error`, then "Nothing was sent." for an errand, or "The call ended: <reason>." for a call.

### Screen 3: Live conversation (PLAN 5.4, Stephen)

Purpose: show the conversation itself: the question, each option as it is read, the pick and the spoken reply.

Focus: the option being read right now.

```
 Partner asked
 "<partner's question>"                                         --text-lead

    1   <option text>                                           --text-hero
  | 2   <option text>                                 reading   bright
    3   <option text>                                 Errand
    4   <option text>                                 Call

          ( YES )    ( NO )    ( CONFIRM )    ( STOP )

 Spoken reply   "<reply text>"
```

- See `docs/mockups/conversation.html`. Under the current option: "In the earpiece now" with the word being read marked (Cartesia word timestamps), and a time-left bar that starts only after the clip ends, because the confirm window opens after the audio. Below the list: "NO means none of these. Silence means nothing happens." and "Pass 1 of 2". At the bottom: "Said out loud" with the reply, which appears only after YES.
- Parts: rows at `--text-hero`, chips, the status line.
- All options are the same size, so nothing jumps. The current one is `--fg`, weight 500, with a 4 px `--accent` bar and `--active` fill. The others are `--fg-muted`. A chip says "Errand" or "Call" when `kind` is not `reply`. Sources stay off this screen; they belong to Live data.
- Pick: the picked option keeps its bar and gains "Picked" in `--accent`. The cursor stops and the reply line appears.
- Command strip: four chips at the bottom center, where tube puts its search pill. When a command event arrives, its chip lights for 1.2 s (`--accent` border, `--accent-soft` fill). It is a legend and a live echo of the headset.
- Rows: `option` for the current `question_id` and latest `version`, in `rank` order. The cursor comes from the scan clock row (name pending) or the latest `speak` row in `pipeline_event`. The pick is the latest YES command event. The reply text source is pending.
- Live: the bar moves to the next option in 160 ms. A new `version` of the options replaces the list with a 150 ms fade (tube re-keys its results body on each search and fades it in).
- Empty: "Waiting for the partner to ask something." at `--text-lead`.
- Loading: the status line. While Plan runs: the question, then a spinner and "Drafting options" (tube shows "Searching" while a query runs).
- Error: "Could not draft options. Ask again." with the failed mark.
- Paused or headset off: the list drops to 40% opacity and the cursor stops, under the shell banner.

### Screen 4: Partner phone view (PLAN 5.5, Stephen)

Purpose: let the partner ask a question from their phone and see where it is at a glance.

Focus: one status sentence at the top, then the reply.

```
+----------------------------------+
| Say When                  o Live |
|                                  |
| Reading the options              |   --text-lead
|                                  |
| [v] Heard you                    |
| [v] Looked it up                 |
| [*] Reading options              |
| [ ] Picked                       |
|                                  |
| Reply                            |
| "<reply text>"                   |   --text-lead
|                                  |
| ( Type a question...      Send ) |   56 px pill
+----------------------------------+
```

- See `docs/mockups/partner.html`. The main action is one large "Hold to ask" button with a live mic level: Cartesia Ink-2 listens only while it is held, which also keeps speech to text from billing silence. Under the status sentence: "Please wait. They are listening to the options." The typed question below is a fallback.
- Parts: status line (large), step list, pill input.
- Steps in human words, the way tube names its stages ("Preparing video", "Finding cars and people" in `videos.ts`): Heard you (Listen ok), Looked it up (Search and Retrieve ok), Reading options (Speak started), Picked (YES on an option).
- Input: 56 px pill, 16 px text (iOS zooms into inputs under 16 px; tube's pill input is 14 px), "Send" as a text button inside the pill.
- Rows: `pipeline_event`, `option`, command events. Sending needs a reducer for a typed question, which is not in the draft contracts. Until it exists, ship this view read-only and let the partner ask out loud.
- Layout: one column, `--gutter` on each side, max width 480 px, centered. No sideways scroll at 390 px. Check it, because tube's `/app` fails this.
- Empty: "Ask a question out loud, or type it here."
- Loading: the status line.
- Error: "Could not send. Try again." above the pill, with `role="alert"`.
- Paused: "Paused. Please wait." Headset off: "Headset off. Please wait."

### Contract gaps for PLAN 1.2

1. `pipeline_event` has no question id. Add `question_id`, or the UI treats each Listen start as a new question.
2. The shape of `detail` for each stage. A JSON string per stage is simplest.
3. The command event table name, and how STOP and HEADSET-OFF clear.
4. Where the scan cursor lives, so Conversation knows which option is being read.
5. The values of `errand.status` and `call_request.status`, and whether an errand carries the time its confirm window closes.
6. Where call transcript lines and the spoken reply text live.
7. A reducer for a typed question from the phone.
8. A reason field on errand and call rows, so the screens can tell Refused (a safety rule) from Stopped (NO, STOP, headset off, or the window ran out) from Failed.
9. Our own Ringing and Connected call events, since Cartesia's call status has only created, started, completed and failed.

## Motion

| What moves | How | Tube source |
|---|---|---|
| Hover and focus color | 150 ms ease | `.pill` border 150 ms, `.lp-link` 160 ms |
| New content in a region | fade in, 150 ms | `.fade-in` 150 ms |
| Card or dialog in and out | 160 ms, rises 7 px and fades | archive `panel-in`, `panel-out` |
| New row (search row, transcript line) | 240 ms ease-out, grows from zero height and fades in | archive `row-in` (`grid-template-rows`) |
| Image loaded | fade in, 250 ms | archive `.thumb img` |
| Progress bar | 300 ms ease | `/app` `.progress` |
| A number that only grows (total time) | counts up over about 1 s, ease-out cubic, never counts down | `Percent` in `UploadPanel.tsx` |
| Spinner | 0.8 s linear, endless | `.spinner` |
| Scan cursor | 160 ms `--ease-out` | ours |
| Command chip echo | on in 150 ms, holds 1.2 s, off in 300 ms | ours |

Reduced motion: under `prefers-reduced-motion: reduce`, drop every slide, fade and count-up, so values switch at once. Keep the spinner, since it is the only sign of work. This follows tube's archive, which turns off its panel, tab, row, bar and image motion in one block. Tube's `/app` only stops its mic ring, and its 3D intro and camera moves ignore the setting.

## Accessibility

- Contrast, measured with the WCAG 2 formula on `#050505`: `--fg` 15.6:1, `--fg-muted` 5.7:1, `--accent` 9.5:1, `--error` 7.7:1, `--highlight` 5.8:1. Targets: 4.5:1 for all text, 3:1 for anything that shows state (bars, rings, the cursor, focus). Tube's hairline (1.38:1), hover fill (1.09:1) and selected fill (1.20:1) are decoration, never the only sign of state.
- Focus: a visible 2 px outline on everything focusable. Never remove an outline without a visible replacement; tube's rows replace it with a 5% fill (1.09:1).
- Keyboard: tabs are links; 1, 2, 3 switch screens; arrows step through questions on Live data; Esc closes the dialog. Everything works without a mouse.
- Live regions, as tube uses them: status sentences get `role="status"`, errors `role="alert"`, bars `role="progressbar"` with `aria-valuenow`. Do not make the option list a live region; it changes every few seconds. Announce the pick only.
- Words for every state: Done, Running, Waiting, Not sent, Paused. Color is a second cue.
- Room size: body never under 16 px, meta never under 14 px, the question at 28 px, options at 32 to 48 px. Check each screen from the far side of the judging table on the demo laptop.
- Phone: 16 px inputs, touch targets of at least 44 px, no sideways scroll at 390 px.

From switch-scanning software for people who cannot speak (TD Snap, Grid 3, Cboard, Apple Switch Control):

- Never advance the cursor before the option's audio ends. Show "reading" and "window open" as two phases.
- Keep each option's first words short (TD Snap suggests cues of "three words or less"), so the person knows quickly whether to wait for it.
- Pause on the first option so the person can get ready, show the time left on the current option, and stop after a set number of passes with "No pick. Nothing was said or sent."
- Never auto-select when time runs out (Apple's single-switch step scanning does; we must not). Silence means no action.
- Make the cursor impossible to miss and not color-only: a 4 px outline, a background tint, and the words "In the earpiece now".
- Show ignored signals (repeats inside the refractory time) in the event feed, like Grid 3's switch tester, so the room can see the debounce working.
- Keep "STOP means none of these" on screen. AI-drafted options are a form of partner-assisted scanning, which AAC guides call limiting when there is no way out of the list.

## Build order

1. [ ] Stephen (5.1): Next.js app in `web/`, `app/globals.css` with the tokens above, Geist and Geist Mono through `next/font/google`.
2. [ ] Stephen (5.1): `SpacetimeDBProvider`, the header and tabs, keys 1/2/3, the connection chip, the headset chip and banner.
3. [ ] Stephen: the shared parts (TextLink, Row, StepList, Chip, Card, Bar, Spinner, StatusLine, PillInput, Dialog), one CSS Module each.
4. [ ] Stephen: until PLAN 1.1 lands, build against a local fixture of rows, as tube does with `npm run dev:fixture`. Keep fixture code out of the deployed build; the judges' URL shows real rows only.
5. [ ] Stephen (5.4): Live conversation.
6. [ ] Stephen (5.2): Live data.
7. [ ] Stephen (5.3): Agents at work.
8. [ ] Stephen (5.5): Partner phone view.
9. [ ] Stephen: every screen's empty, loading, reconnecting, error, paused and headset-off states.
10. [ ] Stephen: check at 1440x900 and 390x844, keyboard only, reduced motion on, and on the demo laptop from across the table.
