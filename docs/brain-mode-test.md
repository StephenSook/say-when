# Brain commands: the test they must pass first

Written and committed before any measurement, so the bar cannot move after we see the numbers. This version replaces the earlier single-fist test: the command map now uses both hands.

## The command map

| Signal | Means |
|---|---|
| Imagine squeezing your right fist | YES: pick this one. While nothing is happening, it opens the person's own menu. |
| Imagine squeezing your left fist | NO: skip, or answer no. |
| Single jaw clench | CONFIRM: the only way anything leaves the room (a form or a call). |
| Double jaw clench | STOP: cancel, none of these, hang up, pause. |

The brain makes the choices and the jaw commits or stops. The jaw clench is a muscle signal (EMG), not a brain signal, and we say so. Nothing leaves the room without a fresh single clench after the spoken read-back. (PLAN D17 swapped the jaw map on Oct 24; until then a double was CONFIRM and a single was STOP. The pass bar below did not change.)

## The rule

Imagined left and right fist squeezes count as the YES and NO commands for this wearer, today, only if all of these hold:

1. The headset has electrodes at C3 and C4, over the hand areas of the motor cortex. A Muse cannot do this; its sensors are at TP9, AF7, AF8 and TP10.
2. The decoder was trained only on an earlier calibration block of 60 to 90 cued trials, split evenly between left, right and rest.
3. The headset was then taken off and put back on.
4. 60 fresh trials followed: 20 left, 20 right and 20 rest, in random order, with spoken cues, eyes on a fixed point, hands flat and visible on the table, and the jaw relaxed.
5. At least 15 of 20 were right in EACH class. Any trial flagged as an artifact counts as a miss, never dropped.
6. At most 2 of the 40 left and right trials were read as the opposite hand, because a YES read as a NO (or the reverse) is the costly mistake.
7. In a control block (10 single jaw clenches, 10 double clenches, 30 s of talking, 30 s with eyes closed, 60 s of idle listening) it produced zero YES and zero NO. A jaw clench must never be read as a fist.
8. Jaw-muscle power at the temple sites and eye movement at the forehead sites did not differ systematically between the imagery trials and the rest trials.

If any condition fails, the hands are not used today, and the fallback below runs instead. The measured numbers go in the README as an experiment either way.

## The fallback (jaw only)

- YES: a single jaw clench.
- NO: silence. The option times out and the next one plays.
- CONFIRM: a double clench. A single clench is YES in this mode, so the fallback keeps the old double-clench CONFIRM; in the main map (PLAN D17) a double is STOP.
- STOP: the decoder cannot tell a held clench (PLAN D16), and in this mode a single clench is YES, so there is no STOP gesture unless the decoder adds a triple clench. Nothing leaves the room without a CONFIRM, and a teammate can STOP from the station keys.

## What a pass means

- Guessing among three classes is right one time in three. Getting 15 or more of 20 in one class by guessing has a probability of about 0.0002.
- Even 15 of 20 leaves a wide 95% confidence interval (about 51% to 91%), so we report "15 of 20", not "75% accurate".
- Zero detections in about 60 control events still allows up to about 5% per event at 95% confidence.
- Imagined movement is slow, so each option gets a response window of about 3 to 4 seconds, set from the wearer's calibration.
- A pass covers this wearer, this headset, today, these conditions. It does not mean the headset reads intentions. People with ALS have learned imagined-movement control in published studies, but it took months of training, so we say the design is built so the brain can carry the choices, and that we tested it on a builder.

## How we talk about it

- Passed: "Imagining a left or right fist squeeze is a trained brain command for [wearer] today: [N] of 20 right for each hand and [N] of 20 for rest, fresh trials, where guessing gets about 7, and zero false commands while they clenched, talked and looked around."
- Failed: "We tested imagined fist squeezes as YES and NO. They scored [N] of 20, below the bar we wrote down before testing, so YES is a single jaw clench today."
- Never say "thought commands", "mind control" or "it reads what they want".
