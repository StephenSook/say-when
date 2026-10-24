# Say When

A screenless reply and errand assistant for people who cannot speak or use their hands.

A conversation partner asks a question out loud. Say When drafts up to four answers, reads them one at a time into an earpiece, and the person picks one with a head-worn signal (a jaw clench or a deliberate eye movement, read by an EEG headset). The name comes from switch scanning: options go by until the person says "when".

Anything that leaves the room, like sending a form or placing a phone call, is read back first and only happens after a fresh confirm.

Built at Cal Hacks 13, October 23 to 25, 2026.

## How it works

1. **Listen.** The partner's question becomes text (Cartesia Ink-2).
2. **Look it up.** Apify searches and scrapes the web (RAG Web Browser for open questions, Google Maps Scraper for places).
3. **Recall.** Moss retrieves from the fresh web results and from the person's own memory.
4. **Plan.** Claude drafts and ranks up to four options.
5. **Speak.** Cartesia Sonic reads each option into the earpiece.
6. **Choose.** The headset decoder turns signals into four commands.
7. **Act.** ERRAND fills a form with our Apify form-errand Actor. CALL places a consented phone call with a Cartesia voice agent. Both only after a read-back and a fresh confirm.

Every step writes to SpacetimeDB, so the dashboard on any laptop updates live over WebSocket subscriptions. Tiger Data keeps switch timing and latency telemetry.

## The four commands

| Command | What it does | Example signal (jaw and eyes profile) |
|---|---|---|
| SELECT | Picks the option just heard. Inside a confirm window it releases the pending action. | Double jaw clench |
| NO | Skips, cancels, or hangs up. It can only stop things. | Sustained jaw clench |
| ERRAND | Asks the agent to prepare a form. Nothing is sent yet. | Look left, hold, look back |
| CALL | Asks the agent to prepare a call. Nothing is dialed yet. | Look right, hold, look back |

Two automatic safety states sit outside the four: PAUSE (eyes closed for about 3 seconds) and HEADSET-OFF (contact lost). Both cancel anything pending.

Signals differ per person. An eyes-only profile exists for people who can no longer clench reliably. These are muscle and eye signals picked up by the headset, not mind reading.

## Safety rules

- The model never clicks submit and never dials. ERRAND and CALL only prepare and read back.
- Fail closed. Silence, a timeout, NO, PAUSE, or a lost signal all mean "do not act".
- A confirm must be fresh: it starts after the read-back ends, lands inside the window, matches the digest of what was read back, and is used once.
- Calls go only to people who consented. The voice says it is an automated assistant with an AI-generated voice, says who it calls for, and gives a callback number.
- The form-errand Actor only fills forms on an allowlist and refuses CAPTCHAs, logins, passwords, payments, and uploads.

## Repo layout

| Path | What |
|---|---|
| `spacetime/` | SpacetimeDB module: tables, reducers, scheduled scan clock |
| `switch/` | Headset reader, four-command decoder, calibration |
| `agent/` | Speech to text, option planner, earpiece voice, call agent |
| `apify/form-errand/` | Apify Actor: preview, read back, submit |
| `apify/search/` | Apify search and scrape client (RAG Web Browser, Google Maps) |
| `moss/` | Moss retrieval over web results and the person's memory |
| `web/` | Live dashboard and partner phone view |
| `telemetry/` | Tiger Data telemetry writer and SQL |

Team coordination lives in [PLAN.md](PLAN.md).

## Getting started

```bash
git clone https://github.com/StephenSook/say-when.git
cd say-when
git config core.hooksPath .githooks   # warns when you edit files under someone else's active task
cp .env.example .env.local            # fill in your own keys; never commit them
./scripts/plan ls                     # see open tasks
```

Each folder has its own README with run and test commands.

## License

MIT. See [LICENSE](LICENSE).
