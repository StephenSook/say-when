"""Moss (retrieval), Cartesia (voice and transcription) and the laptop's mic and speaker.

Keys come from the environment or the repo's gitignored .env.local - never from code or arguments.
Every service has an offline fallback, labelled as such, so the flow can be tested without keys:
  Moss      -> local word-overlap ranking
  Cartesia  -> Windows' built-in voice for speech; typing the question instead of transcription
"""
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from typing import Dict, List, Optional

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moss_bridge.mjs")

# Cartesia voice configuration (API version, model and voice as in cartesia/src; speed and format chosen for this test)
CARTESIA_API = "https://api.cartesia.ai"
CARTESIA_VERSION = "2026-08-14"
SONIC_MODEL = "sonic-3.6"
ASSISTANT_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
SAMPLE_RATE = 44100
GENERATION = {"speed": 1.5, "volume": 1}
STT_MODEL = "ink-whisper"   # batch transcription model; override with --stt-model if the API asks for another


def load_env(path: str = os.path.join(REPO, ".env.local")) -> Dict[str, str]:
    """Reads KEY=value lines into os.environ without overriding what is already set."""
    found = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8-sig"):  # tolerates the BOM PowerShell writes
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(2) and not line.lstrip().startswith("#"):
                found[m.group(1)] = m.group(2).strip('"').strip("'")
                os.environ.setdefault(m.group(1), found[m.group(1)])
    return found


# ------------------------------------------------------------------ retrieval
def restaurant_rows(restaurants: List[dict]) -> List[dict]:
    """Restaurants as Moss "maps" search rows (moss/src/web.ts SearchRow)."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return [{"id": r["id"], "source": "maps", "title": r["name"], "text": r["description"], "fetchedAt": now,
             "facts": {"rating": r["rating"], "category": r["cuisine"], "address": r["address"]}} for r in restaurants]


class LocalRanker:
    """Fallback when Moss is not configured: ranks by shared words with the query."""
    name = "local word overlap (no Moss keys)"

    def __init__(self):
        self.docs: Dict[str, str] = {}

    def start(self):
        pass

    def index(self, question_id: str, restaurants: List[dict]):
        self.docs = {r["id"]: f"{r['name']} {r['description']}".lower() for r in restaurants}

    def search(self, question_id: str, query: str) -> List[str]:
        words = set(re.findall(r"[a-z$]+", query.lower())) - {"a", "in", "the", "me", "give", "restaurant", "find"}
        score = {rid: sum(w in text for w in words) for rid, text in self.docs.items()}
        return sorted(score, key=lambda rid: -score[rid])

    def close(self):
        pass


class MossRanker:
    """The repo's Moss package through moss_bridge.mjs. Indexes locally; billing counts session minutes."""
    name = "Moss"

    def __init__(self):
        env = dict(os.environ)
        env.setdefault("MOSS_SNAPSHOT_DIR", os.path.join(REPO, "moss", ".memory"))
        env.setdefault("MOSS_IDLE_CLOSE_MS", "300000")
        self.proc = subprocess.Popen(["node", BRIDGE], cwd=os.path.dirname(BRIDGE), env=env, text=True,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.last_ms = None

    def _call(self, op: str, **kw) -> dict:
        req_id = uuid.uuid4().hex[:8]
        self.proc.stdin.write(json.dumps({"id": req_id, "op": op, **kw}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Moss bridge exited")
        msg = json.loads(line)
        if not msg.get("ok"):
            raise RuntimeError(f"Moss {op} failed: {msg.get('error')} {msg.get('message', '')}")
        return msg

    def start(self):
        self._call("start")

    def index(self, question_id: str, restaurants: List[dict]):
        self._call("index", questionId=question_id, rows=restaurant_rows(restaurants))

    def search(self, question_id: str, query: str) -> List[str]:
        msg = self._call("search", questionId=question_id, query=query, topK=50)
        self.last_ms = msg.get("mossMs")
        return [h["id"] for h in msg["order"]]

    def close(self):
        try:
            if self.proc.poll() is None:
                self._call("close")
        except Exception:
            pass
        finally:
            if self.proc.poll() is None:
                self.proc.terminate()


def make_ranker(use_moss: bool = True):
    if use_moss and os.environ.get("MOSS_PROJECT_ID") and os.environ.get("MOSS_PROJECT_KEY"):
        return MossRanker()
    return LocalRanker()


# ------------------------------------------------------------------ Cartesia
class Cartesia:
    def __init__(self, api_key: str, voice: str = ASSISTANT_VOICE, stt_model: str = STT_MODEL):
        self.key, self.voice, self.stt_model = api_key.strip(), voice, stt_model

    def _request(self, path: str, body: bytes, content_type: str) -> bytes:
        req = urllib.request.Request(CARTESIA_API + path, data=body, method="POST", headers={
            "X-API-Key": self.key, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:  # body may explain (bad model, bad key); never echo the key
            raise RuntimeError(f"Cartesia {path} HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}") from None

    def tts_request(self, text: str) -> dict:
        return {"model_id": SONIC_MODEL, "transcript": text, "voice": self.voice,
                "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": SAMPLE_RATE},
                "generation_config": dict(GENERATION)}

    def speak_wav(self, text: str) -> bytes:
        return self._request("/tts/bytes", json.dumps(self.tts_request(text)).encode(), "application/json")

    def transcribe(self, wav_bytes: bytes) -> str:
        boundary = uuid.uuid4().hex
        parts = []
        for name, value in (("model", self.stt_model), ("language", "en")):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="question.wav"\r\n'
                     f'Content-Type: audio/wav\r\n\r\n'.encode() + wav_bytes + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        out = self._request("/stt", b"".join(parts), f"multipart/form-data; boundary={boundary}")
        return json.loads(out).get("text", "").strip()


# ------------------------------------------------------------------ voice out / mic in
class Voice:
    """Speaks into the default audio device (the earpiece). Cartesia Sonic if a key is set, else Windows' voice."""

    def __init__(self, cartesia: Optional[Cartesia], log=print, mute: bool = False):
        self.cartesia, self.log, self.mute = cartesia, log, mute
        self.cache: Dict[str, bytes] = {}
        self.name = "muted (printed only)" if mute else             "Cartesia Sonic" if cartesia else "Windows voice (no CARTESIA_API_KEY)"

    def say(self, text: str):
        self.log(f"  [voice] {text}")
        if self.mute:
            return
        if self.cartesia:
            try:
                return play_wav(self.clip(text))
            except Exception as e:
                self.log(f"  ! Cartesia speech failed ({e}); using Windows voice")
        windows_say(text)

    def clip(self, text: str) -> bytes:
        """Cartesia audio for text, cached; call ahead of time to have a phrase ready."""
        if text not in self.cache:
            self.cache[text] = fix_wav(self.cartesia.speak_wav(text))
        return self.cache[text]

    def prefetch(self, texts):
        """Generate clips in the background, one at a time (the Cartesia plan limits concurrent requests)."""
        if self.cartesia and not self.mute:
            todo = [t for t in texts if t and t not in self.cache]
            threading.Thread(target=lambda: [_quiet(self.clip, t) for t in todo], daemon=True).start()


def _quiet(fn, *a):
    try:
        fn(*a)
    except Exception:
        pass


def fix_wav(data: bytes) -> bytes:
    """Cartesia's WAV is written for streaming: its RIFF and data sizes are 0xFFFFFFFF ("unknown"),
    which Windows refuses to play. Fill in the real sizes."""
    import struct
    out = bytearray(data)
    if out[:4] != b"RIFF":
        return data
    struct.pack_into("<I", out, 4, len(out) - 8)
    i = 12
    while i + 8 <= len(out):
        cid, size = bytes(out[i:i + 4]), struct.unpack_from("<I", out, i + 4)[0]
        if cid == b"data":
            struct.pack_into("<I", out, i + 4, len(out) - i - 8)
            break
        i += 8 + size + (size & 1)
    return bytes(out)


def play_wav(data: bytes):
    if sys.platform == "win32":
        import winsound
        winsound.PlaySound(fix_wav(data), winsound.SND_MEMORY)


def windows_say(text: str):
    if sys.platform == "win32":
        safe = text.replace("'", "''")
        subprocess.run(["powershell", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; "
                        f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{safe}')"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def beep(freq=900, ms=150):
    if sys.platform == "win32":
        import winsound
        winsound.Beep(freq, ms)


def record_wav(seconds: float, rate: int = 16000) -> bytes:
    """Records the default mic (mono 16 kHz) and returns WAV bytes."""
    import sounddevice as sd
    audio = sd.rec(int(seconds * rate), samplerate=rate, channels=1, dtype="int16")
    sd.wait()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(audio.tobytes())
    return buf.getvalue()
