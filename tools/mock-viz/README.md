# Screen 1 mock scenarios (port 8766)

- **For:** whoever checks the /brain page (Screen 1) and Shashank, who will hook the real decoder bridge up to it.
- **What it is:** scripted frames in the port 8766 viz protocol (`tools/VIZ_PROTOCOL.md`), one file per screen state, a replay tool that plays them to the page (`tools/viz_replay.py`), and a test that runs every file through the page's own logic (`web/test/brain-mock-scenarios.test.ts`).
- **Not a measurement.** Every file is scripted by `make_scenarios.py`. Each `viz.meta` note ends "Not a measurement." Nothing here came from a person.

## The scenarios

The numbers follow the synthetic bridge (`VIZ_PROTOCOL.md` section 5): the same six-band filter bank, the same change per band for an imagined squeeze, a jaw clench that lifts 20 to 30 Hz by +150 to +300 on both sides, 10 Hz `viz.mi` and `viz.spec`, 2 Hz `viz.quality`. Times below are seconds from the start of the file at speed 1.

| Scenario | What it plays | What the screen should show |
|---|---|---|
| `01-rest` | 10 s of rest, baseline set, every band within about 4 points of 0 | Pill "Synthetic test signal", no state line, both patches dark, strip lines on the dashed rest line |
| `02-right-fist-yes` | right fist 3 to 6 s: C3 8-12 Hz about -30, slow potential about +25, C4 near 0; YES (imagery, 0.85) at 5.4 s | C3 glows cyan, C4 dark; at 5.4 s the cyan pill "Guess YES 0.85", a cyan ring on C3, "YES 0.85" on the guesses lane |
| `03-left-fist-no` | the mirror: C4 about -30, C3 near 0; NO (imagery) at 5.4 s | C4 glows amber, amber pill "Guess NO 0.8x", amber ring on C4 |
| `04-double-clench-stop` | clenches at 4.0 and 4.4 s, `emgGate` true for 2 frames each, EMG about 100 to 140 uV; STOP (jaw) at 4.9 s (a double clench is STOP, PLAN D17) | "Muscle detected. Brain readings paused." during each clench, both sides "no reading", shaded moments on every row; "STOP" on the jaw lane; no guess pill, no ring |
| `05-single-clench-confirm` | one clench at 4.0 s, `emgGate` true for 3 frames; CONFIRM (jaw) at 4.8 s (a single clench is CONFIRM, PLAN D17) | the muscle line for about 0.3 s, then "CONFIRM" on the jaw lane |
| `06-headset-off` | rest; contact poor at 4.5 s, off at 5.0 s; HEADSET_OFF (source `contact`) at 5.05 s; then no frames at all | "No signal" about 0.5 to 0.6 s after the last frame, both sides "no reading", legend "C3 no contact", "C4 no contact"; the pill stays (the socket is open) |
| `07-baseline-flow` | baseline none 0 to 2 s, recording 2 to 7 s, set at 7 s; every ERD field 0 until set; right fist 11 to 14 s, YES at 13.4 s | "No rest baseline" with a Record link, then "Recording rest baseline" (band lines hidden), then no state line; C3 glows from about 11.5 s |
| `08-brain-test-failed` | `brainTest` failed with a summary; right fist 3 to 6 s; no YES (imagery is not used today) | "Brain test failed. YES is a jaw clench today."; the C3 glow at about a third of 02's; the info dialog shows the summary |
| `09-replay-label` | source `replay` with `recordedAt` 1792850400; left fist and NO | Pill "Replay, recorded HH:MM" (local time of that stamp), amber glow and NO pulse |
| `10-bad-contact` | rest; C4 poor 2 to 7 s, then off; C4 power rises (noise), C3 normal | Legend "C4 poor contact", then "C4 no contact"; C4 rows climb above the rest line; the C4 patch stays dark (only quieting glows) |
| `11-legacy-bridge` | an older bridge: no `filterBank`, no `fb`, bands 8-13 and 13-30; right fist and YES | Two strip rows, "Mu 8-13 Hz" and "Beta 13-30 Hz"; C3 glows from `mu` |
| `12-malformed` | 02's trial moved to 6 to 9 s, with 41 bad lines between the frames: cut-off JSON, non-objects, unknown types, 8765 messages, NaN, Infinity, 1e999, bad and oversized `fb`, ERD out of range, 300 bins, 65 channels, bad metas, MAYBE, confidence 1.5, a repeated marker id, a 64 KB frame, two binary frames, an empty frame | Looks like 02 at 6 s: one "Guess YES", no MAYBE, no second NO, no console errors; a short gap in the band rows where the one frame with a 5-entry `fb` arrived (the page drops that `fb` and keeps the frame) |
| `13-key-press` | rest; YES at 2.5 s and NO at 6.0 s from source `key`, confidence null | Neutral pill (plain border, no cyan or amber) "YES, key press", then "NO, key press"; no ring; gray-bordered pills on the guesses lane |
| `20-demo-run` | 60 s labeled `replay`: rest, right fist and YES (10.4 s), rest, left fist and NO (22.4 s), rest, double clench and STOP (33.9 s), rest, single clench and CONFIRM (45.8 s), rest | Pill "Replay" the whole time (never "Live"); cyan glow and YES, amber glow and NO, the muscle line twice, STOP and CONFIRM on the jaw lane; "No signal" after 60 s |
| `90-live-label-test` | 8 s of rest labeled `live` | Pill "Live headset". **Test fixture only.** The replay tool refuses it without `--allow-live-label` and prints a warning with it; `--all` skips it |

`20-demo-run` says `replay` with `recordedAt` null, so the pill reads "Replay" without a time: nothing was recorded, and the page must never say Live for a file. Only `90-live-label-test` says `"source":"live"`, and the test fails if any other file does.

## Playing them to the page

Only one program can listen on 8766, so stop the synthetic bridge first. Then open the page (`npm run dev` in `web/`, then http://localhost:3000/brain) and:

```sh
VENV=/path/to/viz-venv          # the venv from tools/requirements-viz.txt; the replay needs only websockets
$VENV/bin/python tools/viz_replay.py --list                 # every scenario, one line each
$VENV/bin/python tools/viz_replay.py 02-right-fist-yes      # or just: 02
$VENV/bin/python tools/viz_replay.py 02 04 06               # several, in this order
$VENV/bin/python tools/viz_replay.py --all --loop           # everything except 90, forever
$VENV/bin/python tools/viz_replay.py 20-demo-run --loop
$VENV/bin/python tools/viz_replay.py 04 --hold-at 4.05      # freeze on the muscle state to look at it
$VENV/bin/python tools/viz_replay.py 07 --speed 4 --exit-when-done
```

- The timeline starts when the first page connects and is shared by every open page. A page that joins late gets the newest `viz.meta` first.
- When the last scenario ends the frames stop and the socket stays open, so the page shows No signal. `--loop` repeats; Ctrl-C stops.
- `--hold-at S` plays one scenario to S seconds and then repeats the newest `viz.mi`, `viz.spec` and `viz.quality` (never a marker) until Ctrl-C. Handy for a screenshot or a side-by-side look; the guess pill still fades after 4 s.
- The Record link (and "Record again" in the info dialog) sends `viz.cmd` baseline. In `07-baseline-flow` the tool replays the recording frames and then the rest of the file; every other scenario ignores it and says so.
- Loopback only: any `--host` other than 127.0.0.1 is refused, and so is port 8765.

## File format

JSON Lines. The first line is `{"at":0.0,"info":{"scenario","description","screen","seconds","seed"}}`. Every other line is `{"at": seconds, "frame": {...}}` with one protocol message exactly as the bridge sends it. `12-malformed` also has `"raw"` (text sent as is) and `"bytes"` (hex, sent as a binary frame), and every bad line carries `"expect"` (`"reject"`, or `"fb_ignored"` for the one the page uses without its `fb`) and `"why"`. Lines from the recording meta to the set meta in `07` carry `"baseline": true`.

Times in a file are placeholders. `viz_replay.py` rewrites them as it sends each frame:

- every numeric `t` (written as the line's `at`) becomes `round(time.time(), 3)`;
- `viz.meta` `baseline.recordedAt` (seconds from the start of the file; -40 means 40 s before it) becomes `time.time() + (recordedAt - at) / speed`;
- each `viz.marker` `id` becomes a fresh uuid4 on every play, the same fresh id for a repeated file id within one play;
- `viz.meta` `recordedAt` (when a replay was recorded) is absolute and left as is.

## Checks

```sh
cd web && npx tsx --test test/brain-mock-scenarios.test.ts      # also part of npm test
$VENV/bin/python tools/mock-viz/make_scenarios.py               # rewrite every file (seeded, same bytes every time)
$VENV/bin/python tools/mock-viz/make_scenarios.py --check       # exit 1 if a file is out of date
```

The test reads every file here, feeds each line through `applyFrame` in time order with a fake clock, checks that every line is used or dropped as marked, checks rates and the same self-consistency `check_viz_bridge.py` checks, and then checks `buildBrainView` and `patchTargets` at the moments in the table above. It runs in well under a second.

`tools/check_viz_bridge.py` also passes against the replay of 01 to 10, 20 and 90 (use `--expect-source` synthetic, replay or live to match, and `--baseline-at 1000` except for 07). Three fail on purpose: 11 has no filter bank (the checker demands one from a synthetic source), 12 is junk, and 13's key-press YES and NO are outside protocol section 3.5, which allows YES and NO only from `imagery` with a confidence (the page handles `key` anyway).

## Hookup checklist for the real decoder

1. Start the real decoder bridge on 127.0.0.1:8766 (stop the synthetic bridge and any replay first).
2. `python tools/check_viz_bridge.py --expect-source live --seconds 30` must print PASS. Run the 8765 station test too; it must still pass unchanged.
3. Open /brain. The pill must read "Live headset". The info dialog's Stream line should name the real board and the real filter.
4. Walk the same states with the headset on, and compare each with its scenario (play it with `viz_replay.py` first, or freeze it with `--hold-at`):
   - rest for 10 s: like `01-rest`. No state line, both patches mostly dark.
   - imagine squeezing the right fist: like `02-right-fist-yes`. C3 cyan, then "Guess YES" and a cyan ring.
   - imagine squeezing the left fist: like `03-left-fist-no`. C4 amber, "Guess NO", amber ring.
   - double jaw clench: like `04-double-clench-stop`. The muscle line while clenching, both sides "no reading", STOP on the jaw lane.
   - single jaw clench: like `05-single-clench-confirm`. CONFIRM on the jaw lane.
   - unplug the headset or stop the decoder: like `06-headset-off`. No signal within about 0.6 s.
   - the Record button: like `07-baseline-flow`, if Stephen agreed the bridge honors `viz.cmd` baseline (`VIZ_PROTOCOL.md` section 6, step 7).
5. Real numbers wander more than these, and a real clench may not land exactly on 100 ms frames. What must match is the state on screen, the side that glows, and which lane each command lands on.

## What the page does not show (seen while checking)

- A `HEADSET_OFF` marker appears nowhere on the page: no pill, no lane. In `06` only the stopped frames (No signal) and the contact legend tell the viewer. If the decoder ever sends HEADSET_OFF while frames keep coming, the page will look normal.
- Contact `poor` or `off` changes only the legend and the info dialog. The glow still follows the numbers, so an off electrode whose power drops would glow.
