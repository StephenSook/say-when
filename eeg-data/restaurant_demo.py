"""TEST: pick a San Francisco restaurant from mock data with the headset, Moss and Cartesia.

  python restaurant_demo.py                 # headset + mic (keys from ../.env.local)
  python restaurant_demo.py --keyboard      # no headset: type c, l, r, d, n (see below)
  python restaurant_demo.py --type-question # type the question instead of speaking it

Flow:
  1. Clench your jaw once  -> a tone, then speak your question ("give me a restaurant in San Francisco")
  2. Cartesia transcribes it; Moss ranks the mock restaurants (../mock-data) against it
  3. Each round reads three choices into your ear (Cartesia voice), for the filter that splits what is left best:
        option 1 = imagine LEFT fist     option 2 = imagine RIGHT fist     option 3 = DOUBLE jaw clench
        LONG jaw clench = none of these (next three, or skip that filter)
  4. Moss re-ranks with your choices; repeat until you pick one restaurant, which is read out and printed.

Keyboard stand-ins: c = single clench, l = left, r = right, d = double clench, n = long clench, q = quit.
Test data only: the restaurants are fictional. Not connected to SpacetimeDB or the agent.
"""
import argparse
import copy
import json
import os
import queue
import sys
import threading
import time
import uuid

from eeg import config, store
from eeg.engine import Engine
from eeg.hands import HandConfig
from restaurant import services
from restaurant.picker import Picker, spoken

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK = os.path.join(services.REPO, "mock-data", "sf_restaurants.json")
LOGS = os.path.join(HERE, "data", "restaurant_logs")
CHOICE = {"left": 0, "right": 1, "double": 2, "long": None}


# ------------------------------------------------------------------ inputs -> "single" | "left" | "right" | "double" | "long"
class HeadsetInput:
    def __init__(self, args, log):
        model, meta, _ = store.load(args.models)
        if not meta["deployable"] and not args.allow_unusable:
            sys.exit("The imagery model did not beat chance; --allow-unusable to try anyway.")
        self.engine = Engine(model, meta, HandConfig(threshold=args.threshold), port=args.port, log=log)
        self.q = queue.Queue()
        self._stop = False
        self.engine.start()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self._stop:
            up = self.engine.poll()
            for ev in up.jaw_events:
                self.q.put(ev["kind"])
            for msg in up.commands:
                if msg["source"] == "imagery":  # right fist: YES (scan map) or PICK_2 (direct map)
                    self.q.put("right" if msg["command"] in ("YES", "PICK_2") else "left")
                elif msg["command"] == "HEADSET_OFF":
                    self.q.put("headset_off")

    def ready(self):
        """Accept a hand answer straight away (skip waiting for a calm moment first)."""
        self.engine.hands.armed = True

    def close(self):
        self._stop = True
        time.sleep(0.2)
        self.engine.stop()


class KeyboardInput:
    KEYS = {"c": "single", "": "single", "l": "left", "1": "left", "r": "right", "2": "right", "d": "double",
            "3": "double", "n": "long", "s": "long", "q": "quit"}

    def __init__(self):
        self.q, self.lines = queue.Queue(), queue.Queue()
        self.capture = False   # True while a typed question is expected
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        for line in sys.stdin:
            if self.capture:
                self.capture = False
                self.lines.put(line.strip())
                continue
            key = line.strip().lower()[:1]
            if key in self.KEYS or line.strip() == "":
                self.q.put(self.KEYS.get(key, "single"))

    def ready(self):
        pass

    def read_line(self, prompt):
        print(prompt, end="", flush=True)
        self.capture = True
        return self.lines.get()

    def close(self):
        pass


def drain(q):
    while not q.empty():
        q.get_nowait()


def wait_for(q, kinds, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            ev = q.get(timeout=0.1)
        except queue.Empty:
            continue
        if ev == "quit":
            raise KeyboardInterrupt
        if ev in kinds:
            return ev
    return None


# ------------------------------------------------------------------ flow
def final_speech(r):
    return (f"{r['name']}. {r['cuisine']}, {r['neighborhood']}, {spoken('price', r['price'])}, "
            f"{r['rating']} stars. {r['address'].split(',')[0]}.")


def next_texts(picker, step):
    """What would be said after each possible answer, so it can be generated while the wearer decides."""
    out = []
    for choice in list(range(len(step.options))) + [None]:
        sim = copy.deepcopy(picker)
        sim.answer(step, choice)
        nxt = sim.next_step()
        out.append(options_speech(nxt, sim)[0] if nxt else final_speech(sim.result) if sim.result else None)
    return out


def options_speech(step, picker):
    """Shortest form: the order IS the mapping (1st = left, 2nd = right, 3rd = double clench)."""
    if step.kind == "pick":
        by_id = {r["id"]: r for r in picker.candidates}
        labels = [by_id[i]["name"] for i in step.options]
    else:
        labels = [spoken(step.attr, v) for v in step.options]
    return f"{step.question} " + ", ".join(labels) + ".", labels


def typed(inp, prompt):
    return inp.read_line(prompt) if hasattr(inp, "read_line") else input(prompt).strip()


def ask_question(args, inp, cartesia, voice, log):
    if args.type_question or not cartesia:
        if not cartesia and not args.type_question:
            log("  (no CARTESIA_API_KEY: type the question instead of speaking it)")
        return typed(inp, "Your question: ")
    services.beep(1000, 120)  # a tone instead of words: start speaking
    log(f"  recording {args.listen:.0f} s ...")
    wav = services.record_wav(args.listen)
    services.beep(600, 120)
    try:
        return cartesia.transcribe(wav)
    except Exception as e:
        log(f"  ! transcription failed ({e})")
        return typed(inp, "Type your question instead: ")


def _try(fn):
    try:
        fn()
    except Exception as e:  # reported by the caller, then the local ranker takes over
        return str(e)
    return None


def run_once(args, inp, ranker, voice, cartesia, restaurants, log):
    log("Ready: clench your jaw once to ask.")
    drain(inp.q)
    while wait_for(inp.q, {"single"}, 3600) is None:
        pass
    # open the Moss session and index the restaurants while the question is spoken and transcribed
    qid = "q-" + uuid.uuid4().hex[:8]
    started = {}
    opener = threading.Thread(target=lambda: started.update(
        error=_try(lambda: (ranker.start(), ranker.index(qid, restaurants)))), daemon=True)
    opener.start()
    question = ask_question(args, inp, cartesia, voice, log)
    log(f'\nQuestion: "{question}"')
    opener.join()
    if started.get("error"):
        log(f"  ! {ranker.name} did not start ({started['error']}); using the local ranker")
        ranker.close()
        ranker = services.LocalRanker()
        ranker.index(qid, restaurants)
    if not question:
        voice.say("I did not catch a question.")
        ranker.close()
        return None
    try:
        picker = Picker([dict(r) for r in restaurants])
        picker.rerank(ranker.search(qid, question))
        heard = picker.apply_question(question)
        log(f"Ranked by {ranker.name}; {len(picker.candidates)} candidates"
            + (f"; from the question: {heard}" if heard else ""))

        rounds = 0
        while (step := picker.next_step()) is not None:
            rounds += 1
            text, labels = options_speech(step, picker)
            log(f"\nRound {rounds} ({step.kind}{': ' + step.attr if step.attr else ''}), "
                f"{len(picker.candidates)} left: " + " | ".join(f"{k}={l}" for k, l in zip(("L", "R", "2x"), labels)))
            choice = "none"
            for attempt in range(2):  # no answer: the options are read once more, without comment
                voice.say(text)
                drain(inp.q)  # nothing said while the options were read counts
                inp.ready()
                if attempt == 0:
                    voice.prefetch(next_texts(picker, step))
                ev = wait_for(inp.q, {"left", "right", "double", "long"}, args.answer_time)
                if ev:
                    choice = ev
                    break
            if choice not in CHOICE or (CHOICE[choice] is not None and CHOICE[choice] >= len(step.options)):
                choice = "long"
            log(f"  -> {choice}")
            picker.answer(step, CHOICE[choice])
            picker.rerank(ranker.search(qid, f"{question}. {picker.preference_text()}"))
        r = picker.result
        voice.say(final_speech(r))
        return {"question": question, "restaurant": r, "choices": picker.chosen, "rounds": rounds,
                "history": picker.history, "ranked_by": ranker.name, "voice": voice.name}
    finally:
        ranker.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keyboard", action="store_true", help="keyboard stand-ins instead of the headset")
    ap.add_argument("--type-question", action="store_true", help="type the question instead of speaking it")
    ap.add_argument("--listen", type=float, default=4.0, help="seconds recorded after the clench")
    ap.add_argument("--answer-time", type=float, default=4.0, help="seconds to answer each round")
    ap.add_argument("--no-moss", action="store_true", help="use the local ranker even if Moss keys are set")
    ap.add_argument("--stt-model", default=services.STT_MODEL)
    ap.add_argument("--threshold", type=float, default=0.6, help="imagery confidence needed")
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--port", default=config.SERIAL_PORT)
    ap.add_argument("--allow-unusable", action="store_true")
    ap.add_argument("--repeat", action="store_true", help="keep going: another question after each result")
    ap.add_argument("--mute", action="store_true", help="print what would be spoken instead of playing it")
    args = ap.parse_args()

    log = lambda *a: print(*a, flush=True)  # noqa: E731
    services.load_env()
    key = os.environ.get("CARTESIA_API_KEY", "")
    cartesia = services.Cartesia(key, stt_model=args.stt_model) if key else None
    voice = services.Voice(cartesia, log, mute=args.mute)
    restaurants = json.load(open(MOCK, encoding="utf-8"))["restaurants"]
    moss_ready = not args.no_moss and os.environ.get("MOSS_PROJECT_ID") and os.environ.get("MOSS_PROJECT_KEY")
    log(f"Mock data: {len(restaurants)} fictional SF restaurants | retrieval: "
        f"{'Moss' if moss_ready else services.LocalRanker.name} | voice: {voice.name}")
    inp = KeyboardInput() if args.keyboard else HeadsetInput(args, log)
    if args.keyboard:
        log("Keys: c = single clench, l = left, r = right, d = double clench, n = long clench, q = quit (then Enter)")
    try:
        while True:
            # a fresh Moss session per question, closed right after (Moss bills open session minutes)
            result = run_once(args, inp, services.make_ranker(not args.no_moss), voice, cartesia, restaurants, log)
            if result:
                os.makedirs(LOGS, exist_ok=True)
                path = os.path.join(LOGS, f"restaurant_{time.strftime('%Y%m%d_%H%M%S')}.json")
                json.dump(result, open(path, "w", encoding="utf-8"), indent=2)
                r = result["restaurant"]
                log(f"\nRESULT: {r['name']} - {r['cuisine']}, {r['neighborhood']}, {r['price']}, {r['rating']} stars"
                    f"\n        {r['address']}\n        log: {path}")
            if not args.repeat:
                break
    except KeyboardInterrupt:
        log("\nStopped.")
    finally:
        inp.close()


if __name__ == "__main__":
    main()
