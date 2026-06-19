#!/usr/bin/env python3
"""GPS watchdog — monitors GPS fix staleness and alerts on dropout.

Polls the Warlock GPS status API every 5s. If no valid TPV fix for more than
STALE_THRESHOLD seconds, plays an audio alert via the TTS pipeline and logs
the event. Designed to run as a systemd service alongside warlock.service.

Environment:
  WARLOCK_GPS_WATCHDOG_STALE   — seconds without fix before alerting (default: 15)
  WARLOCK_GPS_WATCHDOG_INTERVAL — poll interval in seconds (default: 5)
  WARLOCK_GPS_WATCHDOG_REPEAT  — repeat alert every N seconds while still stale (default: 60)
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

API_URL = "http://localhost:7777/api/gps/status"
STALE_THRESHOLD = int(os.environ.get("WARLOCK_GPS_WATCHDOG_STALE", "15"))
POLL_INTERVAL = int(os.environ.get("WARLOCK_GPS_WATCHDOG_INTERVAL", "5"))
REPEAT_INTERVAL = int(os.environ.get("WARLOCK_GPS_WATCHDOG_REPEAT", "60"))
AUDIO_CACHE = os.path.expanduser("~/.hermes/audio_cache")

running = True


def handle_signal(signum, frame):
    global running
    running = False


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def get_gps_status():
    """Fetch GPS status from the Warlock API."""
    try:
        import base64
        req = urllib.request.Request(API_URL)
        creds = base64.b64encode(b"warlock:warlock").decode()
        req.add_header("Authorization", f"Basic {creds}")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"ok": False, "reason": f"api_error: {e}"}


def play_alert(text):
    """Play TTS alert through the warlock TTS pipeline."""
    try:
        subprocess.Popen(
            ["python3", "-c",
             f"from elevenlabs.client import ElevenLabs; "
             f"import os; "
             f"c = ElevenLabs(api_key=os.environ.get('ELEVENLABS_API_KEY','')); "
             f"a = c.text_to_speech.convert(text={text!r}, "
             f"voice_id='pNInz6obpgDQGcFmaJgB', model_id='eleven_turbo_v2_5'); "
             f"open('{AUDIO_CACHE}/gps_alert.mp3','wb').write(b''.join(a))"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # The warlock-tts-player service will auto-play from audio_cache
        print(f"[{time.strftime('%H:%M:%S')}] ALERT: {text}", flush=True)
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] ALERT (TTS failed): {text} ({e})", flush=True)


def main():
    print(f"GPS watchdog started — stale={STALE_THRESHOLD}s, poll={POLL_INTERVAL}s", flush=True)

    last_alert_time = 0
    stale_since = None

    while running:
        status = get_gps_status()

        now = time.time()
        has_fix = status.get("ok", False) and status.get("mode", 0) >= 2

        if has_fix:
            if stale_since is not None:
                print(f"[{time.strftime('%H:%M:%S')}] GPS RECOVERED — fix restored", flush=True)
                play_alert("GPS signal restored.")
            stale_since = None
            last_alert_time = 0
        else:
            if stale_since is None:
                stale_since = now

            stale_duration = now - stale_since
            should_alert = (
                stale_duration >= STALE_THRESHOLD
                and (now - last_alert_time) >= REPEAT_INTERVAL
            )

            if should_alert:
                reason = status.get("reason", "unknown")
                play_alert(f"GPS signal lost. Check iPhone GPS2IP app. Reason: {reason}.")
                last_alert_time = now

        time.sleep(POLL_INTERVAL)

    print("GPS watchdog shutting down.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
