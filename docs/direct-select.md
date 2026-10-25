# Direct select (D18): four gestures pick four options

Status: being built on branch `direct-select` (worktree `../say-when-direct`), Sat Oct 24 2026, from Shashank's design (Discord 8:19 PM and 8:23 PM). The scan mode on `main` and the `say-when-demo` database stay untouched as the fallback.

## 1. What the person does

| Gesture (decoder) | Command word | Meaning |
|---|---|---|
| Imagined LEFT fist | `PICK_1` | choose option 1 |
| Imagined RIGHT fist | `PICK_2` | choose option 2 |
| Single jaw clench | `PICK_3` | choose option 3 |
| Double jaw clench | `PICK_4` | choose option 4 |
| Long jaw clench (held 0.8 s or more) | `STOP` | cancel whatever is pending, hang up a call, pause |
| Headset off | `HEADSET_OFF` | same as today: cancel and pause |

There is no scanning cursor. The earpiece reads the (up to) four options once, numbered and short ("One: yes. Two: no. Three: search the web. Four: something else."), then waits. The person picks any time after the list starts. Silence picks nothing. A STOP or a new question clears the list.

## 2. When a pick needs a confirm (Shashank, 8:23 PM)

Confirmation only for:
- **errands / messages** (the form-errand request), after the read-back;
- **calls**, after the read-back;
- **starting an internet search** (the "search the web" option).

The confirm is a fresh two-option choice spoken after the read-back: "One: send it. Two: cancel." (`PICK_1` = confirm, `PICK_2` = cancel; silence until the confirm window ends = cancel; STOP = cancel). It keeps every existing confirm rule: it starts only after the read-back ends, lands inside the confirm window, matches the read-back digest, and is used once.

Every other pick acts at once with no confirm: a reply is said out loud in the room right away; a category or a place pick moves straight on.

## 3. The conversation flows

1. **Small talk** ("Hey, how are you?"). Claude drafts four options, each with a 1 to 3 word `label` (read in the earpiece) and a full `text` (what the room voice says): e.g. 1 "Good" -> "I'm doing awesome, how about you?", 2 "Not great" -> ..., 3 and 4 other tones. No web search. A pick is spoken in the room at once.
2. **A question that may need outside facts** ("Anything you want to do today in San Francisco?"). Options: 1 yes-style reply, 2 no-style reply, 3 **Search the web** (kind `Search`), 4 something else. Picking 3 asks for the confirm ("Search the web for ideas? One: yes. Two: cancel."). On confirm, the earpiece offers **categories** (kind `Category`, no confirm): e.g. 1 Nature, 2 Fun, 3 Thrill, 4 Something else (the agent may tailor them to the question). Picking a category runs the Apify search (Google Maps near `AGENT_PLACES_NEAR` for places, RAG web otherwise), stores the results the usual way (SpacetimeDB rows plus the per-question Moss index), and offers four places as replies ("Palace of Fine Arts"). A place pick is spoken in the room at once ("Let's go to the Palace of Fine Arts!").
3. **A request** ("Can we send the care team a request for a ride to the aquarium at 1?"). Options include the errand (kind `Errand`, label e.g. "Send request") plus reply options. Picking the errand runs the existing preview and read-back, then the two-option confirm. Sent, as today.
4. **Letting the caregiver know** ("We should let Stephen know the request was sent?"). Options such as 1 "Call Stephen" (kind `Call`), 2 "Message" (only if a message path exists; otherwise a reply), 3 "Yes, agree" (reply), 4 "No need" (reply). The call runs the existing read-back, then the two-option confirm, then dials as today (consent list, 9 AM to 9 PM, AI disclosure, hangs up after goodbye).
5. **Stretch, only if everything above works:** when the call ends, the recipient's last reply (from the call transcript) becomes a follow-up prompt and the person gets four short options to say in the room.

Options are always short: the earpiece label is 1 to 3 words; the spoken text is one short sentence.

## 4. Interfaces (the contract between the three build tracks)

- **Database:** a NEW Maincloud database `say-when-direct`, published from this branch. No migration from `say-when-demo` is needed, so schema changes are free here. Owner = this Mac's spacetime CLI login.
- **Module (spacetime/):**
  - `OptionKind` adds `Search` and `Category`. `answer_option` adds `label: string` (short earpiece text; empty means use `text`).
  - Config/session gets an input mode `Direct` (default `Direct` on this database; keep the scan code path for `Scan`).
  - New gesture handling: the existing `gesture` reducer accepts the command words above. Add `Pick` (with a `rank: u8` 1..4) to the `Command` enum, or add a separate `pick` reducer; the module track decides and documents it here. A pick is valid only while a list is live for the current question (after the first option clip started), for an existing rank; otherwise it is logged and ignored with a reason, like today's ignored gestures.
  - Pick handling by kind: `Reply` -> spoken now (existing reply path). `Category` -> creates the search job for that category (no confirm). `Search`, `Errand`, `Call` -> existing preview/read-back -> confirm phase where `PICK_1` = CONFIRM and `PICK_2` = cancel.
  - Scan clock in Direct mode: read every option clip once in rank order (no per-option response window, no passes), then wait for a pick until `idle_pause_ms`.
  - Everything else unchanged: roles, pairing, consent gate, dead-man heartbeat pause, idle pause, ledger, public pipeline rows, stats.
- **Agent sidecar (agent/):** the planner returns, per option, `label` (1 to 3 words) and `text` (one short sentence), and a kind. It offers `Search` only when the question could use outside facts; small talk never searches. A `Category` follow-up job is answered with up to four category options (no web call); a category pick triggers the search and returns places as `Reply` options with sources. Errand and call options work as today. Never put words in the person's mouth beyond short drafts; the person always picks.
- **Decoder (eeg-data/) and station (web/):** the decoder maps the gestures in section 1 to the command words on ws://127.0.0.1:8765 (keep `HEADSET_OFF` and health messages). The station accepts `PICK_1`..`PICK_4` and `STOP`, sends them to the module, and keeps the keyboard fallback (keys 1, 2, 3, 4 and S). The earpiece reads labels with their numbers. The screens (/replies, /agents, /conversation, /station, /brain) show the numbered options and the gesture legend from one source of truth (web/lib/commands.ts). The /brain screen labels the left fist as "1" and the right fist as "2", and the jaw lane as "3 (single) / 4 (double)".

## 5. Honesty and safety (unchanged rules)

- Nothing leaves the room (errand, message, call, web search start) without a read-back and a fresh confirm pick.
- The jaw clench is a muscle signal; the fists are imagined movements. No "mind reading" wording.
- Calls: consent list only, AI disclosure, 9 AM to 9 PM, never emergency numbers.

## 6. Build tracks

1. Module (spacetime/) + bindings regeneration + tests + publish to `say-when-direct`.
2. Agent sidecar (agent/) planner and job handling + tests.
3. Decoder mapping (eeg-data/) + station, earpiece and screens (web/) + tests.

Each track works on its own branch off `direct-select` in its own worktree, stages named paths only (never the node_modules symlinks), and merges into `direct-select` when its tests pass. Integration and the live run on `say-when-direct` come last.
