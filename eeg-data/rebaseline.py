"""Record a fresh rest baseline for the brain view (/brain), on the laptop running live.py or share.py.

  python rebaseline.py

Sit relaxed and still for 5 s after running it. It only resets what the brain view compares against
(the viz bridge on 127.0.0.1:8766); it never changes the decoder or its commands.
"""
import asyncio
import json
import sys
import time


async def main():
    from websockets.asyncio.client import connect
    try:
        async with connect("ws://127.0.0.1:8766", open_timeout=5) as ws:
            await ws.recv()  # viz.meta
            await ws.send(json.dumps({"type": "viz.cmd", "cmd": "baseline"}))
            print("Recording a new rest baseline: stay relaxed and still for 5 s ...")
            end = time.time() + 10
            while time.time() < end:
                msg = json.loads(await ws.recv())
                if msg["type"] == "viz.meta" and msg["baseline"]["state"] == "set":
                    print("Done: the brain view now compares against this rest.")
                    return 0
            print("No confirmation yet; check that live.py is getting headset data.")
            return 1
    except OSError:
        print("Nothing on ws://127.0.0.1:8766: start live.py or share.py first.")
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
