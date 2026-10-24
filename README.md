# NeuroLingo

A screenless reply and errand assistant for people who cannot speak or use their hands.

A conversation partner asks a question out loud. NeuroLingo drafts up to four answers, reads them one at a time into an earpiece, and the person picks one with an EEG headset: an imagined hand squeeze to choose, and a jaw clench to confirm or stop.

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

Every step writes to SpacetimeDB, so the dashboard on any laptop updates live over WebSocket subscriptions. Every switch command also flows into Tiger Data (TimescaleDB), whose continuous aggregates turn it into reliability numbers: false activations per idle minute and time to pick. Tiger stores timing only, no words.

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

## Status

| Part | Folder | State |
|---|---|---|
| Form-errand Actor | `apify/form-errand/` | Built and published: [Confirm-Gated Form Errand on the Apify Store](https://apify.com/stephensookra/confirm-gated-form-errand), build 0.1.4. 46 tests in CI. Verified on the platform with build 0.1.4 (Oct 24): preview, submit with the confirmed digest, and a repeat submit refused as a duplicate |
| Apify client (search, places, errand) | `apify/client/` | Built, 191 tests in CI |
| Cartesia (speech to text, voice, dictionary, call) | `cartesia/` | Built, 158 tests in CI. Calls fail safe: every number on a public copy is masked, and any refusal-like phrase holds the contact until a person clears it. Live API smoke test pending |
| Moss retrieval | `moss/` | Built, 75 tests in CI; first run against real Moss pending. Memory text stays private unless a memory is marked shareable |
| SpacetimeDB module | `spacetime/` | Built, 155 tests in CI. Four rounds of adversarial review by a second model ([docs/spacetime.md](docs/spacetime.md) section 13). Live on Maincloud as `say-when-dev` (Oct 24) and smoke-tested there after the review: 17 of 17 end-to-end checks ([spacetime/README.md](spacetime/README.md)). Design in [docs/spacetime.md](docs/spacetime.md) |
| Dashboard and partner phone | `web/` | Built, 141 tests and a production build in CI. Reads the live module (`say-when-dev`) as an anonymous viewer, checked in a browser while the module's smoke test ran: the scan cursor, picks, an errand from preview to sent, the sharing toggle, the dead-man pause and every connection state. Words stay hidden unless the room turns sharing on. Spec in [docs/ui.md](docs/ui.md) |
| Agent sidecar (Claude planner, errands, calls) | `agent/` | Built, 191 tests in CI on fakes. Plans up to four options with Claude (structured output, checked strictly), retrieves memory first, searches only when needed, and runs the errand and call steps only after the module records a matching CONFIRM. Not yet run against the live services |
| Tiger Data telemetry | `telemetry/` | Built, 134 tests in CI. Live on a free Tiger service: 5 hypertables, 3 real-time continuous aggregates and retention, verified from the live catalog; pinned TLS. Not yet run during a real session |
| Headset decoder | `switch/` | Shashank; not in this repo yet. Brain test in [docs/brain-mode-test.md](docs/brain-mode-test.md) |

## How we use SpacetimeDB

SpacetimeDB is the whole live backend. One server-side clock (chained scheduled reducers) moves the scan cursor on every screen at once. A heartbeat lease pauses everything if the headset or laptop drops. Consent is a row: a form or a call is released only by a fresh CONFIRM whose digest matches what the person heard. Each device has a role checked in every reducer, per-role views keep private text private, and a public pipeline table drives the live dashboards on any laptop. Details in [docs/spacetime.md](docs/spacetime.md).

Measured on Maincloud (Oct 24, smoke runs with made-up content, not yet a wearer): the scheduled steps ran a median 2 ms after their planned time; a YES that arrived 272 ms after the next option began still picked the option the person heard; with heartbeats stopped, the database paused itself 1501 to 1502 ms after the last one, 4 times out of 4; and every wrong way to release an errand (YES, an early CONFIRM, a CONFIRM inside the quiet hold, a wrong digest, a repeat) was recorded and ignored. Anyone can check the live numbers with no key: `https://maincloud.spacetimedb.com/v1/database/say-when-dev/route/stats`.

## Repo layout

| Path | What | State |
|---|---|---|
| `spacetime/` | SpacetimeDB module: tables, reducers, views, scan clock, consent gate; smoke tools in `spacetime/scripts/` | Built; live as `say-when-dev` |
| `switch/` | Headset reader, four-command decoder, calibration | Planned |
| `agent/` | Option planner and the agent sidecar | Built |
| `apify/form-errand/` | Apify Actor: preview, read back, submit | Built |
| `apify/client/` | Apify client for the agent: web search, places, errand preview and submit | Built |
| `cartesia/` | Ink-2 speech to text, Sonic voice, pronunciation dictionary, outbound call | Built |
| `moss/` | Moss retrieval over web results and the person's memory | Built |
| `web/` | Live dashboard and partner phone view | Built |
| `telemetry/` | Tiger Data telemetry writer, SQL and stats | Built |

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
