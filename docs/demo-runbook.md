# Eleven demo runbook: Sunday, Oct 25

One page for the judging morning. Judging is 10:30 AM to 12:30 PM PDT at our table, live. Devpost is due 8:50 AM (not covered here).

Everything below runs against the demo database `say-when-demo`, the one https://eleven-calhacks.vercel.app reads. Commands run from the repo root on Stephen's Mac, which holds the Keychain keys and the owner's `spacetime` login.

## Words we use (PLAN D16)

| Command | Headset signal | Keyboard stand-in |
|---|---|---|
| YES | imagine squeezing the right fist | key Y |
| NO | imagine squeezing the left fist | key N |
| CONFIRM | double jaw clench | key C |
| STOP | single jaw clench | key S |

- The jaw clench is a muscle signal. The imagined squeeze counts as a brain command only if the wearer passed `docs/brain-mode-test.md` today; otherwise say it is the experiment.
- In a keyboard session say "key Y", never "brain" or "thought". The board already says "Keyboard input" for a `keyboard-` session.
- Nothing reads thoughts. Nothing leaves the room without a read-back and a fresh CONFIRM.

## What runs where

Laptop layout, locked by Stephen on Oct 24:

| Laptop | Runs | Notes |
|---|---|---|
| Shashank's EEG laptop | Screen 1: `https://eleven-calhacks.vercel.app/brain?bridge=1`, and `/station` in its own visible window (never a background tab, so its heartbeats are not slowed) with the wired earpiece | the decoder serves `ws://127.0.0.1:8766` (viz) and `ws://127.0.0.1:8765` (commands), both bound to 127.0.0.1. EEG never leaves this laptop. Chrome asks about devices on the local network: click Allow |
| Our laptop (Stephen's Mac) | Screen 2: `https://eleven-calhacks.vercel.app/agents`, live through SpacetimeDB; `scripts/demo-up.sh` (the agent sidecar) and the owner commands | the only place the keys live |
| Partner phone | `/partner`, label "partner phone 1" | Hold to ask, or type |
| Room speaker | `/speaker` on a laptop with a loudspeaker | only one speaker page, or the reply is said twice |
| Any other screen | `/stage`, `/replies`, `/conversation`, `/live`, `/judge` | anonymous, no pairing |

Check on the EEG laptop before the first judge: `python3 tools/check_viz_bridge.py --seconds 10` (the viz bridge on port 8766 answers with valid messages).

## The morning, minute by minute

**9:00. Preflight on Stephen's Mac** (2 minutes).

- `sysctl kern.num_files kern.maxfiles`. On Oct 24 this Mac sat at 30,700 of 30,720, most of it held by about 215 old Jupyter kernels; at the limit every new connection fails, the sidecar's included. Shut the kernels down or restart the Mac first. `scripts/demo-up.sh` prints the count and warns at 90 percent.
- Power cable in, venue Wi-Fi up, a phone hotspot ready as the backup network.

**9:05. Start the backend: the one command.**

```bash
scripts/demo-up.sh --db say-when-demo --calls
```

- It reads the keys from the Keychain (never printed), starts the sidecar with `caffeinate` so the Mac does not sleep, waits until `/healthz` on `127.0.0.1:8791` says connected and paired, then warms the form-errand Actor, Moss and one voice token. Each warm line should say `ok`.
- `--calls` turns calls on only when the private consent file and call settings exist and `cartesia` `call:check` passes with no contact refused. Calls go only to the consented contact, only 9 AM to 9 PM. If it refuses, it says why and starts nothing; run it again without `--calls` and the demo skips the call.
- Check it: `scripts/demo-up.sh --db say-when-demo status`. Log: `~/.config/say-when/demo-up/say-when-demo.log`.

**9:10. Pair the three pages** (about 2 s each once the code shows).

Start auto-approve on Stephen's Mac first, then open the station, the speaker and the partner pages. Each page pairs by itself, with no code to read out. Auto-approve pairs one page per role and then turns off, so a stranger who opens the public page later is never paired:

```bash
cd scripts && npm run owner -- --db say-when-demo auto-approve --minutes 10   # pairs station, speaker, partner, then stops
npm run owner -- --db say-when-demo state                                     # station, speaker, partner and agent, plus the consent rows
```

To pair a single page by hand instead, read its 6-digit code: `npm run owner -- --db say-when-demo approve <code>`.

Pairing survives a reload. The sidecar's own pairing and the consent rows were done on Oct 24 (below).

**9:15. Set up the station.**

1. Input mode: **Headset** when the decoder shows "Decoder healthy", else **Keyboard test**.
2. Start audio, wait for "Phrases ready 34 of 34". The first load voices them (about 11 s, about 900 voice credits); a reload plays them from the browser in about 0.2 s and voices nothing (measured Oct 24 on a local build; see "Before the event"). A reload still voices the last question's options again (3 requests in the rehearsal). Use one Chrome profile for the station all day, so its stored phrases stay.
3. Start session. The label becomes `headset-demo` or `keyboard-test`.
4. Speaker: Start room voice, then Test voice to set the volume.

**10:20. Right before the first judge.**

```bash
scripts/demo-up.sh --db say-when-demo warm                  # wakes the Actor (about 4 s cold), opens Moss, mints a token
node scripts/demo-owner.mjs --db say-when-demo sharing on   # the screens show the words; turn it off after judging
```

Screen 1 (`/brain?bridge=1`) on the EEG laptop, Screen 2 (`/agents`) on our laptop.

## The 3-minute demo

| Time | Who | What happens on screen and in the earpiece |
|---|---|---|
| 0:00 | Stephen | "Eleven is for someone who cannot speak or use their hands. The person hears up to four answers in an earpiece and picks one." |
| 0:20 | Partner | Asks "Are you tired?" The earpiece says "Yes or no?" YES (key Y or right fist). The room voice says "Yes." A plain yes or no question skips the search and Claude, so it starts in under a second. |
| 0:40 | Partner | Asks an open question that needs a lookup, for example "Which cafe near campus has the best hot chocolate?" Screen 2 and `/live` show memory (Moss), the web search (Apify) and Claude drafting up to four options; each is read into the earpiece in its own tone. YES on the one wanted. The room voice says it. |
| 1:30 | Partner | Asks "Can we send the care team a request for some lunch?" One option is the errand. YES. Our form-errand Actor fills the demo form and reads the values back off the page; the read-back plays in the earpiece and ends "To send it, ..." CONFIRM after the window chime (key C or double jaw clench). The station says Sent. |
| 2:10 | Partner | Asks "Should we send the same lunch request as last time?" The errand option comes back filled from memory ("same as last time"). YES, read-back, CONFIRM, Sent. Nothing is sent from memory without its own read-back and CONFIRM. |
| 2:40 | Partner | Only if `--calls` was accepted: a follow-up option offers to call the consented contact about the sent request. YES, read-back, CONFIRM; the phone rings and the voice says it is an automated assistant with an AI-generated voice. STOP hangs up. |
| 2:55 | Stephen | Points at the safety line: STOP, a lost signal, silence or a timeout all mean nothing is sent. |

If a question gets no errand option, ask again in plainer words ("Please send the care team a lunch request."). The demo form is the Actor's built-in one and sends nothing anywhere.

### What the rehearsal measured (Oct 24, 4:40 PM, `say-when-dev`)

One voiced run of this script on `say-when-dev`, session 26: keyboard input, made-up content, calls off, the real sidecar started by `scripts/demo-up.sh`, the station, partner and speaker pages in a headless Chromium against a production build. One run each, so treat the numbers as rough; the web search time varies most.

| Step | Measured |
|---|---|
| `demo-up.sh pair` (a fresh agent identity, approved by the script) | 6 s |
| `demo-up.sh up` to connected and paired, then warm | 3 s, then warm 4 to 18 s (the Actor's cold start) |
| Pair the station, partner and speaker (`demo-owner.mjs approve`) | 1.8 to 2.4 s each |
| Station ready to start (phrases voiced on a fresh profile) | about 13 s |
| "Are you tired?" to the first read | 0.6 s (the stock Yes and No; no search, no Claude) |
| YES to back to idle | 1.7 s (the 1.5 s cancel window, then the room voice) |
| Open question to the first read | 26.5 s (web search 17.0 s, web index 0.5 s, Claude 5.9 s, voicing 1.6 s) |
| Lunch request to the first read | 8.0 s (no search; Claude 5.2 s) |
| YES on the errand to the read-back starting | 7.9 s (the Actor's preview 5.2 s) |
| CONFIRM to Sent | 4.8 s |
| Station reload mid-session to running again | 5.6 s, no phrase voiced again |
| "Same lunch request as last time?" to the first read | 8.2 s; the errand option came from the past request (`provenance memory`, `pastRequests 1`) |
| Its read-back, then CONFIRM to Sent | 6.0 s after the pick, Sent 4.0 s after CONFIRM |
| STOP while idle, then YES | paused, then resumed |
| `/stage`, `/replies`, `/conversation`, `/live`, `/agents`, `/brain` | each Live with no page error, at the start and the end |

The whole run made 52 voice requests (34 stock phrases, the options, the read-backs and the replies). Not run in this rehearsal: the headset decoder, voice asking from a real phone, and a call (calls stayed off; a separate live call test on `say-when-dev` the same afternoon dialed, rang and connected).

## If something goes wrong

| Problem | What to do |
|---|---|
| Wi-Fi drops for a few seconds | Nothing to do. The station stops its heartbeats, the database pauses ("Signal lost. Nothing will be sent.") and resumes 3 s after the link is back. |
| Wi-Fi is gone | Switch the Mac and the station laptop to the phone hotspot. Everything is in the cloud (SpacetimeDB, Claude, Apify, Moss's key check, Cartesia), so nothing live works offline. |
| Still no network | Open `/agents?replay=1` (or `/stage?replay=1`). Every screen says "Sample replay, not live data" and the chip says Replay. Say out loud that it is a recording of sample rows. |
| The decoder or headset fails | On the station: End session, pick Keyboard test, Start session. Say "key presses stand in for the headset now." |
| No voice in the earpiece | The station says what failed ("Voice off", "Voice service problem"). Without a voice the read-back cannot play, so no errand or call can be sent: that is by design. Check Cartesia credits (Oct 24 they ran out once at 4:09 PM) and keep to typed yes or no questions until it is back. |
| A page reloaded | Station: "Start audio and continue session N". Speaker: Start room voice. Pairing is kept. |
| Paused by a helper | Only the owner resumes: `spacetime call --no-config --server maincloud say-when-demo operator_resume`. |
| The scan looks stuck | End session on the station (or `node scripts/demo-owner.mjs --db say-when-demo end-session`), then Start session. |
| The sidecar misbehaves | `scripts/demo-up.sh --db say-when-demo stop`, then the start command again (about 10 s). |
| `/live` says "Moss paused: usage limit reached" | Memory is off: answers still come, but "same as last time" cannot. Skip that step. Moss bills open session minutes, and `demo-up.sh` reopens Moss on the next question after a 3-minute idle close (`AGENT_MOSS_REOPEN=on`); never add a card (moss/README.md). |
| The contact is on hold after a call | Check with the person first, then `cd cartesia && npm run call:clear-hold -- --contact stephen --reason "<why it is safe>"`. |

## Reset between judges

Usually nothing: each new question replaces the last. For a clean start:

1. End session on the station, then Start session (a new session number; the board follows it).
2. To show "same as last time" fresh, forget the demo's memory: `scripts/demo-up.sh --db say-when-demo stop`, rename `moss/.memory/say-when-demo` to `moss/.memory/say-when-demo-<time>` (keep it, do not delete), then start again. Without a reset, the next judge's first lunch request is already offered "as last time".

## After judging

```bash
node scripts/demo-owner.mjs --db say-when-demo sharing off
node scripts/demo-owner.mjs --db say-when-demo end-session
scripts/demo-up.sh --db say-when-demo stop
```

Then delete the call data (`cd cartesia && npm run call:delete -- <call ids>`), revoke the event devices (`node scripts/demo-owner.mjs --db say-when-demo revoke-others --yes` keeps the agent), and `purge_session` any session with a real person in it (docs/spacetime.md 9.4).

## The state of say-when-demo before the event

Set up on Oct 24, about 4:30 PM PDT:

- Module: unchanged (module v2, the same tables, reducers and views as `say-when-dev`; not published again). Its Cartesia key works: a temporary station minted a 60 s voice token (295 characters), then was revoked.
- Devices: the agent sidecar, paired (token in `~/.config/say-when/agent_token_say-when-demo`); one revoked voice-check station. No station, speaker or partner yet: they pair in the morning.
- Consent rows: `web_search`, `memory`, `board_text`, `errand care_team_request`, `call stephen`.
- Board sharing off, no session, no questions, no errands, no calls.
- Moss memory: empty (`moss/.memory/say-when-demo` does not exist until the first run). Rehearsals use `say-when-dev`'s own memory; `demo-up.sh` refuses to point a dev run at the demo's.

## Before the event (open items)

- The station's stock phrase store (`web/lib/station/phrase-store.ts`) is on `main` but the Vercel site deploys by hand. Until it is deployed, every station reload on the public site voices the 34 phrases again (about 900 credits). Deploy from `web/` with the project linked explicitly (`vercel link --project neurolingo-web`, check `.vercel/project.json`, then `vercel --prod` and `cd scripts && npm run smoke`).
- The headset path from the deployed station page (Chrome's local network prompt) has not run with the real decoder (docs/station.md 5.1 and L4).
