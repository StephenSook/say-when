"""Share the live brain view (/brain) with a teammate through a temporary public link.

  python share.py            # headset
  python share.py --demo     # fake signal, no headset

It starts the web app (port 3000), two Cloudflare quick tunnels (one for the web app, one for the 8766 viz bridge)
and the decoder, then prints ONE link to share:  https://<web>.trycloudflare.com/brain?bridge=wss://<viz>...
Ctrl+C stops everything and the links die with it.

Privacy: while this runs, anyone with the link can watch your live brain readings (the viz channel: band changes at
C3/C4, spectrum, jaw level, commands). This is an exception to tools/VIZ_PROTOCOL.md rule 4 ("no EEG leaves the
laptop") that the wearer chooses on purpose; agree it with the team. Only the display channel is shared: the
station channel (8765) stays on this laptop, and a viewer cannot change anything the decoder does.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), "web")
CLOUDFLARED = shutil.which("cloudflared") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "cloudflared",
                                                          "cloudflared.exe")
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
NPM = "npm.cmd" if sys.platform == "win32" else "npm"


def tunnel(port: int, procs: list, timeout: float = 60.0) -> str:
    """Start a quick tunnel to 127.0.0.1:<port> and return its public https URL."""
    p = subprocess.Popen([CLOUDFLARED, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                         errors="replace")
    procs.append(p)
    found = {}

    def read():
        for line in p.stderr:
            m = URL_RE.search(line)
            if m and "url" not in found:
                found["url"] = m.group(0)
    threading.Thread(target=read, daemon=True).start()
    end = time.time() + timeout
    while time.time() < end and "url" not in found:
        if p.poll() is not None:
            raise RuntimeError(f"cloudflared for port {port} exited")
        time.sleep(0.2)
    if "url" not in found:
        raise RuntimeError(f"no tunnel URL for port {port} after {timeout:.0f} s")
    return found["url"]


def wait_http(url: str, timeout: float = 90.0):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=3)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"{url} did not answer")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="fake signal, no headset")
    ap.add_argument("--port", default=None, help="headset serial port (default from eeg/config.py)")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the web app first")
    args = ap.parse_args()
    if not os.path.exists(CLOUDFLARED):
        sys.exit("cloudflared not found: install it, or put cloudflared.exe in %LOCALAPPDATA%\\cloudflared")

    procs = []
    try:
        if args.rebuild or not os.path.exists(os.path.join(WEB, ".next", "BUILD_ID")):
            print("Building the web app (once) ...")
            subprocess.run([NPM, "run", "build"], cwd=WEB, check=True, stdout=subprocess.DEVNULL)
        print("Starting the web app on port 3000 ...")
        procs.append(subprocess.Popen([NPM, "start", "--", "-p", "3000"], cwd=WEB, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL))
        wait_http("http://127.0.0.1:3000/brain")
        print("Opening the tunnels ...")
        web_url = tunnel(3000, procs)
        viz_url = tunnel(8766, procs)
        cmd = [sys.executable, "live.py", "--allow-origin", web_url]
        if args.demo:
            cmd.append("--demo")
        if args.port:
            cmd += ["--port", args.port]
        print("Starting the decoder ...")
        decoder = subprocess.Popen(cmd, cwd=HERE, stdout=subprocess.DEVNULL)
        procs.append(decoder)
        link = f"{web_url}/brain?bridge={viz_url.replace('https://', 'wss://')}"
        print("\n" + "=" * 72)
        print("SHARE THIS LINK (live while this window runs; Ctrl+C to stop sharing):\n")
        print(f"  {link}\n")
        print(f"  {'DEMO: fake signal, not a measurement' if args.demo else 'LIVE: your headset readings are visible to anyone with the link'}")
        print("=" * 72 + "\n")
        while decoder.poll() is None:
            time.sleep(1)
        print("The decoder stopped.")
    except KeyboardInterrupt:
        print("\nStopping ...")
    finally:
        for p in reversed(procs):
            try:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
                else:
                    p.terminate()
            except Exception:
                pass
        print("Sharing stopped; the links no longer work.")


if __name__ == "__main__":
    main()
