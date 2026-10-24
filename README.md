# Say When

A screenless reply and errand assistant for people who cannot speak or use their hands.

A conversation partner asks a question out loud. Say When drafts up to four answers, reads them one at a time into an earpiece, and the person picks one with an EEG headset: an imagined hand squeeze to choose, and a jaw clench to confirm or stop. The name comes from switch scanning: options go by until the person says "when".

Anything that leaves the room, like sending a form or placing a phone call, is read back first and only happens after a fresh confirm.

Built at Cal Hacks 13, October 23 to 25, 2026.

## How it works

1. **Listen.** The partner's question becomes text (Cartesia Ink-2).
2. **Look it up.** Apify searches and scrapes the web (RAG Web Browser for open questions, Google Maps Scraper for places).
3. **Recall.** Moss retrieves from the fresh web results and from the person's own memory.
4. **Plan.** Claude drafts and ranks up to four options.
5. **Speak.** Cartesia Sonic reads each option into the earpiece.
6. **Choose.** The headset decoder turns signals into four commands: YES, NO, CONFIRM and STOP.
7. **Act.** When the moment calls for it, the options include an errand or a call: our Apify form-errand Actor fills a form, or a Cartesia voice agent places a consented phone call. Both only after a spoken read-back and a double jaw clench.

Every step writes to SpacetimeDB, so the dashboard on any laptop updates live over WebSocket subscriptions. Tiger Data keeps switch timing and latency telemetry.

## The four commands

| Command | Signal | What it does |
|---|---|---|
| YES | Imagine squeezing your right fist | Picks the option just heard, or answers yes. While nothing is happening, it opens the person's own menu ("I need something", "Send a request", "Call", "Say something else"). |
| NO | Imagine squeezing your left fist | Skips the option, or answers no. |
| CONFIRM | Double jaw clench | The only way anything leaves the room: it sends the form or places the call that was just read back. |
| STOP | Long jaw clench, about 1 second | Cancels, means "none of these", hangs up a call, and pauses. |

The brain makes the choices and the jaw commits or stops. Taking the headset off (HEADSET-OFF) and two minutes with no command (auto-pause) also cancel anything pending.

The hand commands are imagined movements read over the motor cortex, so they only count after passing the test in [docs/brain-mode-test.md](docs/brain-mode-test.md), written before anyone measured. If they fail, YES becomes a single short jaw clench and NO becomes silence. The jaw clench is a muscle signal, not a brain signal. Nothing here reads thoughts.

## Safety rules

- The model never clicks submit and never dials. An errand or call option only prepares and reads back; CONFIRM (a double jaw clench) releases it.
- Fail closed. Silence, a timeout, NO, STOP, or a lost signal all mean "do not act".
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
| `apify/client/` | Apify client for the agent: web search, places, errand preview and submit |
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
