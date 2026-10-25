# Viz protocol, port 8766 (Screen 1, the live brain view)

- **For:** Shashank (decoder owner, who will host the real bridge) and whoever builds the Screen 1 page.
- **Synthetic stand-in:** `tools/viz_bridge_synthetic.py` speaks this protocol from BrainFlow's SYNTHETIC_BOARD plus a scripted cycle. It is a test signal, not a measurement.
- **Checker:** `tools/check_viz_bridge.py` connects, validates every message against this document, sends one `viz.cmd`, and exits non-zero on any violation.
- **Version:** `v: 1` in `viz.meta`. The filter bank (`viz.meta` `filterBank`, `viz.mi` `fb`, section 3.2.1) is an optional addition to version 1: a bridge that leaves it out still works, and the page then reads `mu` as before.

## 1. Ground rules

1. **Address.** `ws://127.0.0.1:8766`. The server binds `127.0.0.1` only: never `0.0.0.0`, never a LAN address, never `localhost` (which can mean `::1`). The port can be changed with `--port`, but 8766 is the default the page expects.
2. **8766 is a separate channel from 8765.** Port 8765 is the station's gesture and health channel (`docs/station.md` section 2.4, PLAN Shared Contracts). It stays byte for byte unchanged: the same `gesture` and `health` messages, the same fields, the same timing (`health` at least every 250 ms). Nothing in this document adds to, removes from, or changes 8765. The viz channel is an extra, display-only side channel. If the viz bridge crashes, stalls or has a slow client, the 8765 traffic must not notice.
3. **One destructive read.** Only one process ever calls `board.get_board_data()`: the decoder. That call removes the samples it returns, so a second caller would silently steal half the data from the decoder. The viz bridge gets its data from a copy the decoder hands it (section 6), or, like the synthetic tool, only through `get_current_board_data()`, which does not remove anything.
4. **No EEG leaves the laptop.** Nothing on 8766 is ever written to SpacetimeDB, Tiger telemetry, the cloud, or any network service. The page draws it and forgets it. The page must not forward it either.
5. **Honest labels.** `viz.meta.source` is `"synthetic"` from the synthetic tool, and the page then shows a SYNTHETIC TEST SIGNAL badge. A real bridge must never say `"synthetic"`, and the synthetic tool must never say anything else. The page accepts exactly three values: `"live"` (the real headset through the decoder, badge "LIVE from headset"), `"replay"` (a recorded session played back, badge "RECORDED ... replayed", with the top-level `recordedAt` set), and `"synthetic"`. Any other value is ignored by the page.
6. **Any web page can try to connect.** Browsers apply no CORS rules to WebSockets, so any site open in Chrome on that laptop can open `ws://127.0.0.1:8766`. The real bridge should check the `Origin` header against the page's origin (for example `http://localhost:3000` or the deployed origin). The synthetic tool has `--origin URL` (repeatable) for this; by default it accepts any origin.

## 2. Transport

- JSON text frames, one JSON object per frame. The server never sends binary frames, and it ignores binary frames from clients.
- Server to client: `viz.meta`, `viz.mi`, `viz.spec`, `viz.quality`, `viz.marker`. Client to server: `viz.cmd`.
- `t` is unix seconds as a float (Python `time.time()`, rounded to milliseconds). The bridge and the page run on the same laptop, so `t` compares directly with `Date.now() / 1000`.
- Clients should ignore a `type` they do not know. A breaking change bumps `v`.
- A slow client never holds up anyone else. The synthetic tool skips stream frames (`viz.mi`, `viz.spec`, `viz.quality`) for any client whose send buffer is over 32 KiB, but always queues `viz.meta` and `viz.marker`. It pings every 10 s and drops a client that does not answer within 10 s (browsers answer pings on their own). Client messages over 4096 bytes close that client's connection with code 1009.

| `type` | Direction | When |
|---|---|---|
| `viz.meta` | server to client | first message on every connection, then again on every baseline state change |
| `viz.mi` | server to client | 10 Hz |
| `viz.spec` | server to client | 10 Hz |
| `viz.quality` | server to client | 2 Hz |
| `viz.marker` | server to client | once per decoded command |
| `viz.cmd` | client to server | when the user asks for a new baseline |

## 3. Messages

### 3.1 `viz.meta`

```json
{"type":"viz.meta","v":1,"source":"synthetic","board":"SYNTHETIC_BOARD","srate":250,
 "channels":["C3","C4"],"units":"uV","traceFilter":"none (synthetic)",
 "bands":{"alpha_mu":[8,12],"beta":[12,30]},
 "filterBank":[{"id":"mrcp","lo":0.05,"hi":5,"label":"Slow potential 0.05-5 Hz"},
               {"id":"b8_12","lo":8,"hi":12,"label":"Mu 8-12 Hz"},
               {"id":"b12_16","lo":12,"hi":16,"label":"Low beta 12-16 Hz"},
               {"id":"b16_20","lo":16,"hi":20,"label":"Beta 16-20 Hz"},
               {"id":"b20_26","lo":20,"hi":26,"label":"Beta 20-26 Hz"},
               {"id":"b26_30","lo":26,"hi":30,"label":"High beta 26-30 Hz"}],
 "baseline":{"state":"set","recordedAt":1792867884.112},
 "recordedAt":null,
 "brainTest":{"state":"not_run","summary":null},
 "note":"Scripted imagery cycle for UI testing. Not a measurement."}
```

| Field | Meaning |
|---|---|
| `v` | protocol version, `1` |
| `source` | `"live"`, `"replay"` or `"synthetic"`. The synthetic tool always sends `"synthetic"`, and the page then shows SYNTHETIC TEST SIGNAL. The real decoder bridge sends `"live"`. |
| `board` | BrainFlow board name, for example `"SYNTHETIC_BOARD"` |
| `srate` | sampling rate in Hz (integer), from `BoardShim.get_sampling_rate` |
| `channels` | `["C3","C4"]`, in the order used by `c3` and `c4` everywhere else. The synthetic tool labels the first two EEG rows of the synthetic board as C3 and C4; they are not real C3 and C4. |
| `units` | `"uV"` for signal amplitude |
| `traceFilter` | plain words describing any filter on the signal. `"none (synthetic)"` from the synthetic tool. |
| `bands` | band edges in Hz behind `viz.mi` `mu` and `beta`. The synthetic tool sends `alpha_mu` 8 to 12 and `beta` 12 to 30, because its `mu` repeats the 8 to 12 Hz filter-bank band and its `beta` is the mean of the four filter-bank bands from 12 to 30 Hz (section 3.2.1). A bridge without a filter bank may send its own edges, for example 8 to 13 and 13 to 30. |
| `filterBank` | optional. The decoder's filter bank: 1 to 12 bands in display order, each `{"id","lo","hi","label"}` (section 3.2.1). Leave it out (or send `null`) if the bridge has none. |
| `baseline.state` | `"none"`, `"recording"` or `"set"` (section 4) |
| `baseline.recordedAt` | unix seconds when the current baseline was set; `null` unless `state` is `"set"` |
| `recordedAt` | `null` for live and synthetic data. When `source` is `"replay"`, the unix time the replayed session was recorded (the page shows it in the RECORDED badge). It is not the baseline time. |
| `brainTest` | `{"state":"not_run","summary":null}`. `not_run` is the only state defined so far; `summary` is `null` or a short plain string. Shashank defines the other states when the brain test exists. |
| `note` | one plain sentence for the page to show. The synthetic tool says `"Scripted imagery cycle for UI testing. Not a measurement."`, or, with `--no-script`, `"Raw synthetic board noise for UI testing, no scripted cycle. Not a measurement."` |

### 3.2 `viz.mi` (motor imagery summary), 10 Hz

```json
{"type":"viz.mi","t":1792867890.427,"c3":{"mu":-29.1,"beta":-13.6},"c4":{"mu":-3.0,"beta":-1.4},
 "laterality":26.1,"emgGate":false,"baselineAgeS":42.0,"emg":3.1,"emgThreshold":40.0,
 "fb":{"c3":[24.6,-29.1,-23.4,-15.5,-9.9,-5.6],"c4":[2.1,-3.0,-2.2,-1.6,-1.3,-0.5]}}
```

| Field | Meaning |
|---|---|
| `c3.mu`, `c3.beta`, `c4.mu`, `c4.beta` | ERD in percent: the change in band power against the rest baseline, `(A - R) / R * 100`, where `A` is the band power now and `R` the baseline band power. **Negative means the rhythm quieted** (desynchronization, what imagery of the opposite hand does). Never below -100. One decimal. While there is no baseline (`baseline.state` is `"none"` or `"recording"`), all four are `0.0`. |
| `laterality` | `c4.mu - c3.mu` in percentage points (computed from the rounded values above). Positive means C3 mu quieted more than C4 mu, the pattern of right-hand imagery. `0.0` while there is no baseline. |
| `emg` | jaw muscle level in microvolts RMS. Near 2 to 6 at rest in the synthetic tool, 80 to 150 during a scripted clench. |
| `emgThreshold` | the threshold the decoder uses, in uV RMS. `40.0` in the synthetic tool. |
| `emgGate` | `true` exactly when `emg > emgThreshold`. While it is true, imagery values are muscle-contaminated and the page should say so. |
| `baselineAgeS` | seconds since the baseline was set, one decimal; `null` when there is none |
| `fb` | optional. `{"c3":[...],"c4":[...]}`: ERD in percent per filter-bank band, one entry per `meta.filterBank` band in the same order (section 3.2.1). |

**What the page glows from.** When `fb` is there and `meta.filterBank` has a `b8_12` band with a number in `fb`, the glow at each electrode reads that 8 to 12 Hz value. Otherwise it reads `mu`. In the browser this one rule is `glowErd()` in `web/lib/brain/protocol.ts`. **While `emgGate` is true, the page treats every band as muscle-contaminated and shows no brain glow at all**: a jaw clench raises the upper bands on both sides (section 5), and that is muscle, not brain.

#### 3.2.1 The filter bank

These are the bands the decoder's model uses (from Shashank). The synthetic tool sends exactly these six, in this order:

| `id` | `lo` to `hi` (Hz) | `label` | Use in the decoder's model |
|---|---|---|---|
| `mrcp` | 0.05 to 5 | `Slow potential 0.05-5 Hz` | slow movement-related cortical potential (MRCP) features |
| `b8_12` | 8 to 12 | `Mu 8-12 Hz` | mu rhythm (filter-bank CSP) |
| `b12_16` | 12 to 16 | `Low beta 12-16 Hz` | upper mu and low beta (filter-bank CSP) |
| `b16_20` | 16 to 20 | `Beta 16-20 Hz` | beta (filter-bank CSP) |
| `b20_26` | 20 to 26 | `Beta 20-26 Hz` | beta (filter-bank CSP) |
| `b26_30` | 26 to 30 | `High beta 26-30 Hz` | upper beta (filter-bank CSP) |

Rules for `meta.filterBank` (the page rejects the whole `viz.meta` if any is broken, like any other bad field):

- 1 to 12 entries, in the order the page should draw them.
- `id` matches `^[a-z0-9_]{1,16}$` and is unique in the bank. `b8_12` is the id the glow looks for.
- `lo` and `hi` are numbers in Hz with `0 <= lo < hi <= 200`.
- `label` is a plain string of at most 24 characters, shown as is. Use plain hyphens, not dashes.

Rules for `viz.mi` `fb`:

- `c3` and `c4` are arrays of the same length, one entry per `meta.filterBank` band in the same order. Each entry is the ERD for that band at that electrode, `(A - R) / R * 100` against the rest baseline (negative means quieter), from -100 to 1000, or `null` when that band is not computed. A bad entry, or `c3` and `c4` of different lengths, makes the page drop the whole frame.
- If the length does not match the current `meta.filterBank` (or there is no `filterBank`), the page ignores `fb` and still uses the rest of the frame.
- While there is no baseline, every entry is `0.0`, like the other ERD fields.

In the synthetic tool, `mu` is the `b8_12` value and `beta` is the mean of `b12_16`, `b16_20`, `b20_26` and `b26_30` (one decimal), so the old fields and the filter bank always agree. Older fields stay for pages that do not read `fb`.

**How the synthetic tool computes it.** The 8 to 30 Hz bands use the last 1 s of each channel (Welch, 0.25 s Hann segments, 1 Hz bins; each band takes the bins from `lo` up to but not including `hi`). The slow band uses the last 2 s as one Hann segment, so 0.5 Hz bins from 0.5 to 4.5 Hz: 0.05 Hz cannot be resolved in 2 s, so this is a stand-in, not a slow-potential measurement. It is `null` until 2 s of data exist and stays `null` if the baseline finished before then (only with `--baseline-seconds` under about 1.5). The synthetic board has almost no energy in some bands (C3 above 16 Hz, C4 below 5 Hz), where the raw numbers jump by 20 to 40 % from tick to tick, so the tool adds a steady synthetic background of `2 / f` uV^2/Hz to every band's power before the baseline and ERD math (`viz.spec` does not include it). Band power is then lightly smoothed over about 0.3 s and the scripted changes (section 5) are applied per band. All of it is a test signal.

### 3.3 `viz.spec` (spectrum), 10 Hz

```json
{"type":"viz.spec","t":1792867890.427,"freqs":[1,2,3,"...",40],"c3":[-3.448,"..."],"c4":[-2.211,"..."]}
```

(`"..."` is shorthand here; the real arrays hold 40 numbers.)

| Field | Meaning |
|---|---|
| `freqs` | always `[1, 2, ..., 40]`, Hz, 40 entries |
| `c3`, `c4` | 40 numbers each: `log10` of power spectral density in uV^2/Hz at each 1 Hz bin. Three decimals. |

The synthetic tool uses a Welch PSD over the last 2 s (1 s Hann segments, so 1 Hz bins) and applies each filter-bank band's scripted change to that band's bins (1 to 4 Hz for the slow band, 8 to 29 Hz for the others), so the spectrum and the ERD numbers agree, including the jaw clench rise from 16 to 29 Hz. Expect a large peak at 5 Hz on C3 and at 10 Hz on C4 from the synthetic board (log10 values near 1.8 to 2.4), with a flat noise floor between about -3.5 and -1.5 elsewhere. That shape is an artifact of the synthetic board, not anything brain-like.

### 3.4 `viz.quality` (contact), 2 Hz

```json
{"type":"viz.quality","t":1792867890.427,"contact":{"C3":"good","C4":"good"}}
```

`contact` has one key per entry in `meta.channels`, each `"good"`, `"fair"`, `"poor"` or `"off"`. The synthetic tool always says `"good"`, except that once per cycle it reports `"C4":"poor"` for 2 s (turn that off with `--no-contact-blips`). The blip changes only this message; the numbers are unaffected.

### 3.5 `viz.marker` (a decoded command), on each event

```json
{"type":"viz.marker","t":1792867896.912,"id":"0b6f3c1e-3f43-4f53-9b0e-6c2a3c8f6d21","command":"PICK_2","confidence":0.82,"source":"imagery"}
```

| Field | Meaning |
|---|---|
| `id` | a UUID4 string, unique per marker. From the real decoder: the same id as the matching 8765 `gesture`. |
| `command` | the same word as the 8765 `gesture`. Direct select (D18, `live.py --mode direct`, the default): `"PICK_1"` (imagined left fist), `"PICK_2"` (imagined right fist), `"PICK_3"` (single jaw clench), `"PICK_4"` (double jaw clench), `"STOP"` (long jaw clench) or `"HEADSET_OFF"`. Scan (`--mode scan`): `"YES"`, `"NO"`, `"CONFIRM"`, `"STOP"` or `"HEADSET_OFF"`. |
| `confidence` | a fist command from imagery (`PICK_1`, `PICK_2`, `YES`, `NO`): a number from 0 to 1. Any jaw command (`PICK_3`, `PICK_4`, `CONFIRM`, `STOP`, and every command in the jaw-only fallback): `null`. `HEADSET_OFF`: `null` or 0 to 1. |
| `source` | `"imagery"` for a fist command, `"jaw"` for a jaw command (in the jaw-only fallback `PICK_1` and `PICK_2` come from the jaw too). `HEADSET_OFF`: whatever source the decoder put on 8765 (a short lowercase word matching `^[a-z_]{1,16}$`). |

A marker is display only. The station acts on 8765, never on 8766.

### 3.6 `viz.cmd` (client to server)

```json
{"type":"viz.cmd","cmd":"baseline"}
```

Starts a fresh rest baseline (section 4). The server ignores any other message, any unknown `cmd`, binary frames and bad JSON, and never crashes on them.

## 4. Baseline lifecycle

1. `none`: at startup, only until the first 0.5 s of data has arrived.
2. `recording`: the bridge averages band power for the baseline length (synthetic tool: `--baseline-seconds`, default 5). A `viz.meta` goes out when recording starts.
3. `set`: the average becomes `R`, `baseline.recordedAt` is set, and another `viz.meta` goes out.
4. `viz.cmd` `baseline` at any time drops the current baseline and goes back to step 2. While recording, `viz.mi` sends `0.0` ERD and `null` `baselineAgeS`, the same as `none`.

In the synthetic tool the scripted cycle holds at rest while a baseline records and restarts from the top when it is set, the way a wearer would sit still for the baseline.

## 5. What the synthetic tool plays (so the page can be tested against it)

A 24 s loop, starting when the baseline is set (seconds from the start of the loop):

| Time (s) | What happens | What the page should see |
|---|---|---|
| 0 to 4 | rest | ERD near 0 in every band |
| 4 to 7 | right-fist imagery, 0.5 s smooth rise and fall | C3 `b8_12` (and `mu`) to about -30, the other C3 bands as in the table below, C4 near 0 in every band (within about 5), laterality about +25 |
| 6.4 | `viz.marker` `PICK_2` (`YES` with `--mode scan`), `imagery`, confidence about 0.8 | |
| 7 to 11 | rest | |
| 11 to 14 | left-fist imagery | the mirror image: C4 `b8_12` about -30, C3 near 0, laterality about -25 |
| 13.4 | `viz.marker` `PICK_1` (scan: `NO`), `imagery` | |
| 14 to 18 | rest; C4 contact `poor` from 15 to 17 | |
| 18.0 and 18.4 | double jaw clench, two EMG spikes of 80 to 150 uV RMS | `emgGate` true for 1 or 2 frames per spike; in those frames `b20_26` and `b26_30` jump by +150 to +300 on both sides and `b16_20` by about +25 to +45 (so `beta` reads about +100 to +150) |
| 18.8 | `viz.marker` `PICK_4`, `jaw`, confidence `null` (a double clench is option 4, D18; scan: `STOP`, PLAN D17) | |
| 18.8 to 21.8 | rest | |
| 21.8 to 22.1 | single jaw clench | `emgGate` true for 2 or 3 frames, with the same band jump |
| 22.3 | `viz.marker` `PICK_3`, `jaw`, confidence `null` (a single clench is option 3, D18; scan: `CONFIRM`, PLAN D17) | |
| 22.3 to 24 | rest, then the loop repeats | |

Scripted change per band at full imagery, on the side opposite the imagined hand (C3 for the right fist, C4 for the left). The same side as the hand moves by a tenth of it. Each cycle scales the whole column by a random 0.9 to 1.1. The jaw clench column applies to both sides at once, whatever the imagery is doing.

| band | imagery, opposite side | jaw clench, both sides |
|---|---|---|
| `mrcp` | +25 % (the slow potential rises) | none |
| `b8_12` | -30 % | none |
| `b12_16` | -24 % | none |
| `b16_20` | -16 % | +25 to +45 % |
| `b20_26` | -11 % | +150 to +250 % |
| `b26_30` | -7 % | +200 to +300 % |

Measured in one run (`tools/check_viz_bridge.py --seconds 30` prints the same table): right fist C3 `mrcp` +20.9, `b8_12` -26.7, `b12_16` -21.7, `b16_20` -14.1, `b20_26` -10.1, `b26_30` -9.0, with C4 between -4.5 and +3.2; jaw clench frames `b20_26` about +231 to +240 and `b26_30` about +240 to +252 on both sides. At rest every band wanders by about plus or minus 2 to 4 points (C4 `b26_30` a little more, up to about +13 at times).

Markers are sent on the first 100 ms tick at or after their time, so they can land up to 0.1 s late. The synthetic tool never sends `HEADSET_OFF`. With `--no-script` there is no cycle: ERD is the raw synthetic noise (plus the steady background of section 3.2.1), EMG stays at 2 to 6, and no markers are sent.

## 6. How to wire it into the real decoder

The real bridge lives inside the decoder process, next to the existing 8765 server.

1. **Copy after the one read.** Right after the decoder's single `board.get_board_data()` call, push a copy of the chunk into a bounded ring that only the bridge reads. The decoder never waits for the bridge; when the ring is full the oldest samples fall off. For example:

   ```python
   viz_ring = collections.deque(maxlen=64)   # chunks; about 2 s or more of data

   chunk = board.get_board_data()            # the ONE destructive read, decoder only
   viz_ring.append(chunk[[c3_row, c4_row]].copy())
   ```

   If the decoder and the bridge run on different threads, hand the chunk over with `loop.call_soon_threadsafe(...)` or a lock; never block the decoder.
2. **Serve 8766 on its own.** Start a second websockets server on `127.0.0.1:8766` in the same process. It never shares a socket, a message or a send queue with 8765. Every 100 ms it reads the newest 1 s (for `viz.mi`) and 2 s (for `viz.spec`) from the ring. Use `broadcast()` (websockets 17: `from websockets.asyncio.server import serve, broadcast`) so a slow page cannot slow the decoder, and wrap every viz send in `try` so a viz error can never reach the 8765 path.
3. **Republish each gesture as a marker.** After each `gesture` is sent on 8765 (never before it, never instead of it), send a `viz.marker` with the same `id`, `command`, `source` and `confidence` (`null` for jaw commands if the decoder has no real confidence for them). A `HEADSET_OFF` on 8765 becomes a `HEADSET_OFF` marker.
4. **Forward the decoder's own numbers.** If the decoder already computes mu and beta band power, its rest baseline, the EMG level and the EMG threshold, send those instead of computing a second, different set, so the page shows what the decoder actually used. Convert band power to ERD percent against the decoder's own baseline: `(A - R) / R * 100`. Fill `viz.quality` from the decoder's own contact check.
5. **Forward the decoder's own filter bank.** Send `meta.filterBank` with the bands the model really uses (section 3.2.1, keep the ids, and keep `b8_12` for the 8 to 12 Hz band because the glow reads it) and, in every `viz.mi`, `fb` with the decoder's own per-band values at C3 and C4 against its own baseline. Do not recompute them in the bridge: the screen then can never disagree with the decoder. Send `null` for a band the decoder does not compute. Keep `mu` equal to the `b8_12` value and `beta` to the decoder's 12 to 30 Hz summary, so a page that reads only the old fields shows the same thing.
6. **Meta.** `source` is `"live"` (never `"synthetic"`). Set `board`, `srate`, the real rows behind `"C3"` and `"C4"`, a plain `traceFilter`, `bands` to match what `mu` and `beta` mean, the decoder's baseline state, and `brainTest` once that exists.
7. **The baseline button.** Agree with Stephen before honoring `viz.cmd` `baseline` in the real decoder. Either keep it display only (the bridge records its own viz baseline and never touches the decoder's calibration), or ignore it. A browser message must never change what the decoder sends on 8765.
8. **Check it.** With the decoder running: `python tools/check_viz_bridge.py --expect-source live --seconds 8`. It must print PASS, and the 8765 station test must still pass unchanged. For a live bridge the checker validates `filterBank` and `fb` when they are there; for the synthetic tool it requires them, checks that `mu` and `beta` agree with them, and checks the scripted 8 to 12 Hz dip and the jaw clench rise.

## 7. Running the synthetic tool and the checker

```sh
python3 -m venv /path/to/viz-venv
/path/to/viz-venv/bin/pip install -r tools/requirements-viz.txt
/path/to/viz-venv/bin/python tools/viz_bridge_synthetic.py            # Ctrl-C to stop
/path/to/viz-venv/bin/python tools/check_viz_bridge.py --seconds 8    # in a second terminal
/path/to/viz-venv/bin/python tools/check_viz_bridge.py --seconds 30   # a full cycle, with the per-band table
```

Options for the synthetic tool: `--port` (default 8766; 8765 is refused), `--baseline-seconds` (default 5), `--no-script`, `--no-contact-blips`, `--mode direct|scan` (the marker words, default `direct`), `--origin URL`. Any `--host` other than `127.0.0.1` is refused. It prints one line at startup and one status line every 10 s.
