# eeg-data: headset decoder

Turns the 8-channel headset into Eleven's four commands. It is not connected to the station or SpacetimeDB yet: it prints the messages the station will receive.

| Signal | Command | How it is read |
|---|---|---|
| Imagine squeezing your right fist | YES | Imagery classifier over C3/C4 and neighbours (brain signal): at once at 0.90 confidence or more, or the 10 s fallback (PLAN D21) |
| Imagine squeezing your left fist | NO | same, at once at 0.96 or more, or the 10 s fallback |
| Single jaw clench | CONFIRM | Jaw-muscle (EMG) bursts, 30-55 Hz (PLAN D17) |
| Held jaw clench (about 1 s; it fires at 0.8 s) | STOP | same (PLAN D21) |
| Double jaw clench | nothing | detected, but sends no command (PLAN D21) |
| No packets for 0.5 s | HEADSET_OFF | watchdog |

Imagery is ignored during a jaw clench and for 1 s after it, so a clench is never read as a fist. With `--jaw-only` (the fallback in [docs/brain-mode-test.md](../docs/brain-mode-test.md)), a single clench is YES, a double is CONFIRM, silence is NO and there is no STOP gesture (this fallback map did not change with D17 or D21).

Imagery rules (PLAN D21, `eeg/hands.py`), all on the smoothed model probabilities. Every number is a `live.py` flag, and `live.py` prints them at startup:

| Rule | Default | Flag |
|---|---|---|
| A right fist at or above this is YES at once | 0.90 | `--yes-threshold` |
| A left fist at or above this is NO at once | 0.96 | `--no-threshold` |
| Fallback window: with no command for this long, the hand with more confident moments is sent | 10 s | `--fallback-s` (0 turns it off) |
| A prediction at or above this counts as a confident moment for its hand | 0.65 | `--fallback-threshold` |
| The winning hand needs at least this many; a tie or zero sends nothing | 3 | `--fallback-min` |

The fallback window starts with the first prediction and starts again after every command the decoder sends (YES, NO, CONFIRM, STOP) and after HEADSET_OFF, and also when it ends with nothing sent. After a hand fires, nothing fires or counts for `--refractory` (2 s), and that hand cannot fire at once again until it drops below its threshold, so one long squeeze is one YES. A fallback YES or NO carries the mean of its counted moments as its confidence (0.65 or more) and the last counted moment as its onset. The `--threshold`, `--margin`, `--dwell` and `--rearm` flags are gone (the old rule was a single threshold held for a 1 s dwell).

Trade-off: the at-once thresholds mean fewer false picks but a stronger or longer imagined squeeze. The 10 s fallback can turn sustained noise into a pick; the minimum of 3 confident moments limits that but does not remove it (a 10 s window holds about 100 predictions).

The detector still recognizes a double clench, so two quick clenches are never reported as two singles (two CONFIRMs); they send nothing. A STOP is sent as soon as a clench has been held for 0.8 s (`LONG_CLENCH_S`), while it is still held.

A single clench is only reported once 0.7 s pass with no second clench, so a CONFIRM lands about 0.7 s after the clench ends. The CONFIRM only counts inside the confirm window after a full read-back; a stray one anywhere else does nothing. Raising `JAW_RATIO` in `eeg/config.py` to about 30 makes a stray clench (swallowing, shifting) less likely to count.

## Setup (Windows, Python 3.11 or 3.12)

```powershell
cd eeg-data
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Headset: BrainFlow board 57 on `COM11`. Find the port under Device Manager, Ports, "USB Serial Port"; every script takes `--port`. Channels must be wired in this order: FC4, C4, CP4, C2, C1, CP3, C3, FC3.

## Use

| Step | Command |
|---|---|
| Record calibration (left, right, rest; 20 each) | `python collect.py --subject S01` |
| Record jaw clenches | `python collect.py --subject S01 --classes clench --trials 20` |
| Evaluate and train | `python train.py` |
| Run the decoder (JSON lines on stdout) | `python live.py` or `python live.py --window` |
| Jaw-only fallback | `python live.py --jaw-only` |
| Practice / test quiz | `python quiz.py` (`--demo` without a headset) |
| Live brain view | `python brain_view.py` (`--demo` without a headset) |
| Tests (no headset) | `python -m pytest -q` |

### Recording

Each trial is 2 s get ready, a 3 s cue (text, a tone per class, and the cue spoken aloud with `--speak`), then 2-3.5 s of rest. Cues come in shuffled, balanced blocks, never more than 3 alike in a row. After every trial it prints:

- whether all data arrived (`data recorded: YES (375/376 samples)`)
- whether the trial is unusable: missing data, a large spike or movement, a flat channel, or for a clench cue no clench of at least 20 times the resting jaw level. Unusable trials are left out of training. Muscle during imagery is only reported, never dropped.
- how strong it looked: for a hand, the mu/beta drop on the opposite side (C4 for left, C3 for right) compared with the 2 s before the cue; for a clench, the strongest jaw spike

Ctrl+C or a crash still saves every finished trial, and a file is never overwritten. Each sitting is a new `data/sessions/<subject>/<subject>_ses-NN_<time>.npz` holding the continuous raw EEG, timestamps, a marker for every cue, the per-trial checks and the settings.

### Training and the numbers it prints

`train.py` filters every recording the same causal way the live decoder does and cuts each trial into 2 s windows. It then:

1. Puts a test set aside before anything else: the newest session if it has at least 10 trials per class, otherwise about 20% of trials.
2. Cross-validates two models: filter-bank CSP with shrinkage LDA, and Riemannian tangent space with logistic regression. The windows of one trial never land on both sides of a split.
3. Keeps the simpler one unless the other is clearly better (one standard error).
4. Prints, per class, "N of M right", the left/right swaps (a YES read as NO is the costly mistake), and how often rest was read as a hand.
5. Saves to `models/<time>/` and points `models/LATEST` at it.

A model is marked usable only if its cross-validated trial accuracy is at least chance plus 10 points and clearly above guessing; `live.py` and `quiz.py` refuse it otherwise.

Current model (wearer S01, 8 sessions, 337 trials, Oct 22 and 24): on 67 held-out trials 50 right: left 21 of 29, right 19 of 23, rest 10 of 15 (chance 1 in 3), with 7 left/right swaps. These are offline numbers on recorded trials, not the brain-mode test, which needs the headset taken off and put back on, fresh cued trials and a control block.

Jaw check on the recorded clench session: all 20 clench trials were caught, and no CONFIRM or STOP fired during any of the 60 imagery trials. Single clenches also showed up between trials (swallowing, shifting). Since D17 a single clench is CONFIRM, which the module ignores outside the confirm window; this is why `JAW_RATIO` should go to about 30.

## Brain view

`brain_view.py` connects to the headset and shows a top-down head map of the 8 electrodes in their real positions (MNE standard_1005).

- **Colours:** each electrode's mu/beta power compared with your own resting level, interpolated over the area the electrodes cover. Blue means power dropped (that part of the motor cortex is working); red means it rose.
- **What to expect:** imagining your LEFT fist should turn the right hemisphere (C4 side) blue, and your RIGHT fist the left hemisphere (C3 side). When one side clearly drops more than the other, that hand area glows and is named.
- **Electrode problems:** a red ring means an electrode is off (flat); orange means noisy.
- **Side panel:** the model's left/right/rest, the jaw-muscle level against the 20x clench line, the hemisphere averages, the samples per second, and the last commands.
- **Controls:** a band picker (mu, beta, or both) and an "I'm resting" button. The button takes the next 3 s as your new resting level. That level also follows slow drift, but only while an electrode is near rest, so a long imagery does not become the new normal.

## Test: pick a restaurant with the headset (mock data)

`restaurant_demo.py` runs the whole loop on the fictional San Francisco restaurants in [../mock-data](../mock-data). It is a test harness: it is not connected to SpacetimeDB or the agent.

1. **Ask.** Clench your jaw once. After a tone, speak your question, for example "give me a restaurant in San Francisco". Cartesia transcribes it.
2. **Rank.** Moss, through the repo's `moss/` package and `restaurant/moss_bridge.mjs`, indexes the restaurants locally and ranks them against the question. Filters the question already names, such as "cheap" or "Italian", are applied straight away.
3. **Choose.** Each round, the filter that splits the remaining restaurants most evenly (cuisine, neighbourhood, price, diet or vibe) offers three choices, read into your ear by Cartesia:

   | Choice | Signal |
   |---|---|
   | Option 1 | Imagine your LEFT fist |
   | Option 2 | Imagine your RIGHT fist |
   | Option 3 | Double jaw clench |
   | None of these, or the next three | Long jaw clench |

4. **Repeat.** Moss re-ranks with your choices. Once three or fewer restaurants are left, it offers the restaurants themselves. When one is chosen it is read out, printed and logged to `data/restaurant_logs/`.

```powershell
python restaurant_demo.py                   # headset + mic
python restaurant_demo.py --type-question   # headset, type the question
python restaurant_demo.py --keyboard        # no headset: c = clench, l / r = left / right, d = double, n = long, q = quit
python restaurant_demo.py --keyboard --mute # print what would be spoken
```

Keys are read from the repo's gitignored `.env.local`, or from the environment: `CARTESIA_API_KEY`, `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` (and optionally `MOSS_SNAPSHOT_DIR`, default `moss/.memory`). Without them, each piece falls back and says so: Moss is replaced by a local word-overlap ranker, Cartesia's voice by Windows' built-in voice, and the spoken question by a typed one. A Moss session opens when a question arrives and closes when the restaurant is found, because Moss bills open session minutes. Build `moss/` once with `npm ci && npm run build`.

## Output

One JSON object per line, in the shape PLAN.md agrees with the station page:

```json
{"type": "gesture", "id": "6f1c...", "command": "YES", "onsetAgeMs": 1180, "confidence": 0.93, "source": "imagery"}
{"type": "health", "decoderHealthy": true}
```

`command` is YES, NO, CONFIRM, STOP or HEADSET_OFF. `source` is imagery, jaw or watchdog. A health message goes out about every 200 ms. `--log file.jsonl` also appends to a file.

`live.py` also serves two local WebSocket channels, both on 127.0.0.1 only and only to the web app's origins (`localhost:3000` and the Vercel site, plus any `--allow-origin`):

| Channel | For | What |
|---|---|---|
| `ws://127.0.0.1:8765` | the station page and `/quiz` | the gesture and health messages above, plus an `eeg` frame about 10 times a second (model bars, jaw level) that the station ignores |
| `ws://127.0.0.1:8766` | Screen 1, `/brain` | the viz protocol in [tools/VIZ_PROTOCOL.md](../tools/VIZ_PROTOCOL.md): the decoder's own six filter-bank bands at C3 and C4 as ERD against a display-only baseline, the spectrum, contact and a marker per command. It passes `tools/check_viz_bridge.py --expect-source live`. Its own thread and server, so it cannot hold up 8765; a baseline asked for by the page never changes the decoder. |

`python live.py --demo` sends a fake signal on both channels without a headset; on 8766 it says `source: "synthetic"`, so `/brain` shows its synthetic badge. `--no-serve` and `--no-viz` turn the channels off.

To use the web pages on the EEG laptop: run `live.py`, then `npm run dev` in `web/` and open `http://localhost:3000/brain` (live brain) or `http://localhost:3000/quiz` (true or false practice: TRUE = right fist, FALSE = left fist).

## Layout

```
collect.py  train.py  live.py  quiz.py
eeg/
  config.py     headset, channels, labels, bands, timing, thresholds, command map
  board.py      BrainFlow open / read / close
  filters.py    causal filter bank (same output in chunks or whole), jaw envelope
  sessions.py   recording files, trials -> 2 s windows
  models.py     filter-bank CSP + LDA, Riemannian tangent space + logistic regression
  evaluate.py   held-out test, grouped cross-validation, per-class counts
  hands.py      probabilities -> LEFT/RIGHT events: at-once thresholds and the 10 s fallback (PLAN D21)
  jaw.py        streaming single / double / long (held) clench detector
  messages.py   gesture and health messages
  engine.py     live loop: headset -> filters -> model + jaw -> messages, watchdog
  store.py      save / load models with montage checks
  ui.py         bars and the background thread for the windows
tests/          synthetic-signal tests (they check the code, not the BCI)
data/ models/   recordings and trained models (not committed)
```

## Data and privacy

`data/` and `models/` are listed in `eeg-data/.gitignore`, following the repo rule that raw headset recordings stay on the laptop. They exist on the machine that recorded them; nothing personal is pushed unless the wearer agrees and those lines are removed.

Recording format `mi_session_v1` is the same one the earlier motor-imagery prototype wrote, so those 8 sessions load as they are.
