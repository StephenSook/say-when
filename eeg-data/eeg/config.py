"""Single source of truth for the headset, labels, signal bands, timing and command map.

Every script reads these values, so collection, training and live decoding cannot drift apart.
"""

# ---------------------------------------------------------------- headset
BOARD_ID = 57                      # BrainFlow board id of the 8-channel headset
SERIAL_PORT = "COM11"              # Windows: Device Manager -> Ports -> "USB Serial Port"
# Fixed wiring order over the hand areas of the motor cortex (C3 = left hemisphere, C4 = right).
CHANNELS = ["FC4", "C4", "CP4", "C2", "C1", "CP3", "C3", "FC3"]
# Per-channel gain and bias-drive setup sent after the stream starts.
BOARD_SETUP = [cmd for ch in range(1, 9) for cmd in (f"chon_{ch}_12", f"rldadd_{ch}")]
SETUP_PAUSE_S = 0.8                # pause after each setup command
WATCHDOG_S = 0.5                   # no packets for this long -> HEADSET_OFF

# ---------------------------------------------------------------- labels
# Integer codes stay identical to the recordings made so far.
LABELS = {"left": 0, "right": 1, "rest": 2, "both": 3, "clench": 4}
LABEL_OF = {v: k for k, v in LABELS.items()}
IMAGERY = ("left", "right", "rest")      # the brain test: left vs right vs rest
JAW = ("clench",)                        # muscle (EMG) classes: activity is the signal, not an artifact

CUES = {
    "left":   "IMAGINE squeezing your LEFT fist - keep your hand still",
    "right":  "IMAGINE squeezing your RIGHT fist - keep your hand still",
    "both":   "IMAGINE squeezing BOTH fists - keep your hands still",
    "rest":   "REST - relax, imagine nothing",
    "clench": "CLENCH your JAW (bite down) - keep your hands still",
}

# ---------------------------------------------------------------- command map
# Two maps, chosen with live.py --mode (docs/direct-select.md):
#   direct (D18, the default): four gestures pick four options. Imagined LEFT fist = PICK_1, imagined RIGHT fist =
#           PICK_2, single jaw clench = PICK_3, double jaw clench = PICK_4, long jaw clench (held LONG_CLENCH_S) = STOP.
#   scan   (D11 + D17, the say-when-demo database): right fist = YES, left fist = NO, single clench = CONFIRM,
#           double or long clench = STOP (docs/brain-mode-test.md).
# The jaw maps live in messages.py; HEADSET_OFF (the watchdog) is the same in both.
MODES = ("direct", "scan")
DEFAULT_MODE = "direct"
HANDS = ("left", "right")
HAND_COMMANDS = {
    "direct": {"left": "PICK_1", "right": "PICK_2"},
    "scan": {"right": "YES", "left": "NO"},
}
PICKS = ("PICK_1", "PICK_2", "PICK_3", "PICK_4")
MODE_COMMANDS = {
    "direct": PICKS + ("STOP", "HEADSET_OFF"),
    "scan": ("YES", "NO", "CONFIRM", "STOP", "HEADSET_OFF"),
}
COMMANDS = PICKS + ("YES", "NO", "CONFIRM", "STOP", "HEADSET_OFF")   # every word either map can send

# ---------------------------------------------------------------- signal processing
FS_NOMINAL = 125.0
FILTER_ORDER = 4
BANDS = {                                # causal Butterworth band-pass bank
    "0.05-5": (0.05, 5.0),
    "8-30": (8.0, 30.0),
    "8-12": (8.0, 12.0),
    "12-16": (12.0, 16.0),
    "16-20": (16.0, 20.0),
    "20-26": (20.0, 26.0),
    "26-30": (26.0, 30.0),
}
FBCSP_BANDS = ["8-12", "12-16", "16-20", "20-26", "26-30"]
COV_BAND = "8-30"                        # band for covariance / Riemannian features
EMG_BAND = (30.0, 55.0)                  # jaw muscle shows up above the mu/beta range

# ---------------------------------------------------------------- trial timing (seconds)
PREP_S = 2.0
CUE_S = 3.0                              # imagery period; most people hold focus about 2-3 s
ITI_S = (2.0, 3.5)
SETTLE_S = 15.0                          # filter settling + resting baseline at session start

# ---------------------------------------------------------------- windows
WINDOW_S = 2.0                           # classifier window: training crops == live window
CROP_START_S = 0.5                       # skip reaction time after the cue
CROP_STEP_S = 0.5

# ---------------------------------------------------------------- quality checks
SPIKE_UV = 200.0                         # 8-30 Hz peak-to-peak above this = movement / bumped electrode
FLAT_UV = 0.3                            # 8-30 Hz std below this = electrode off
MIN_DATA_FRACTION = 0.95                 # less than this share of expected samples = incomplete trial

# ---------------------------------------------------------------- jaw (EMG)
JAW_RATIO = 20.0                         # clench = EMG power >= this x resting baseline
JAW_RELEASE = 0.5                        # burst ends when power falls below JAW_RATIO * JAW_RELEASE x baseline
JAW_SMOOTH_S = 0.05                      # envelope smoothing (fast enough to see the gap in a double clench)
MIN_BURST_S = 0.08                       # shorter bursts are blips and are ignored
JAW_SLICE_S = 0.25                       # slice for "strongest spike" checks in recordings
LONG_CLENCH_S = 0.8                      # a burst this long is a long clench (STOP in both maps)
DOUBLE_GAP_S = 0.7                       # a second short burst starting within this gap = double (PICK_4; scan: STOP)
JAW_HOLDOFF_S = 1.0                      # no fist command from imagery during a clench and for this long after

# ---------------------------------------------------------------- formats
SESSION_FORMAT = "mi_session_v1"         # unchanged, so earlier recordings load as-is
MODEL_FORMAT = "saywhen_eeg_model_v1"
