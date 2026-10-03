#!/usr/bin/env python3
"""B@B Jarvis voice daemon.

Listens on the default microphone for "hey Jarvis" (openWakeWord, pretrained
`hey_jarvis`), plays a chime, records until the speaker stops (energy VAD),
transcribes with whisper.cpp (`whisper-cli`, ggml-small.en, Metal), and POSTs
{"text": ...} to the agent at http://127.0.0.1:$JARVIS_PORT/voice.

While Jarvis is talking (GET /speaking -> {"speaking": true}) the audio is
dropped, so it never wakes on, or transcribes, its own voice.

Run by launchd as com.bab.voice through voice/run.sh. By hand:
    voice/run.sh                 listen
    voice/run.sh --selftest      load the wake model, transcribe a `say` sample, no mic
    voice/run.sh --list-devices  print input devices (for VOICE_INPUT_DEVICE)

Settings come from the environment, then from the repo's .env.local (see
README "Voice").
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

VOICE_DIR = Path(__file__).resolve().parent
REPO_DIR = VOICE_DIR.parent

SAMPLE_RATE = 16000
CHUNK = 1280  # 80 ms, the frame size openWakeWord expects
CHUNK_MS = CHUNK * 1000 // SAMPLE_RATE

log = logging.getLogger("voice")


# ---- settings ---------------------------------------------------------------

def load_env_file(path: Path) -> dict[str, str]:
    """Minimal .env parser: KEY=VALUE lines, optional quotes and `export`."""
    out: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        out[key] = value
    return out


_ENV_FILE = load_env_file(REPO_DIR / ".env.local")


def setting(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        value = _ENV_FILE.get(name, "")
    return value if value != "" else default


def setting_float(name: str, default: float) -> float:
    raw = setting(name, str(default))
    try:
        return float(raw)
    except ValueError:
        log.warning("%s=%r is not a number; using %s", name, raw, default)
        return default


class Config:
    def __init__(self) -> None:
        port = setting("JARVIS_PORT", "3001")
        self.base_url = f"http://127.0.0.1:{port}"
        self.wake_model = setting("VOICE_WAKE_MODEL", "hey_jarvis")
        # openWakeWord's own default is 0.5. Higher cuts false triggers from
        # the TV or music saying something close to "Jarvis".
        self.wake_threshold = setting_float("VOICE_WAKE_THRESHOLD", 0.6)
        # Frames in a row (80 ms each) that must be over the threshold.
        self.wake_frames = max(1, int(setting_float("VOICE_WAKE_FRAMES", 2)))
        self.input_device = setting("VOICE_INPUT_DEVICE", "") or None
        self.chime = setting("VOICE_CHIME", "/System/Library/Sounds/Tink.aiff")
        self.silence_ms = int(setting_float("VOICE_SILENCE_MS", 900))
        self.start_timeout_s = setting_float("VOICE_START_TIMEOUT", 4.0)
        self.max_seconds = setting_float("VOICE_MAX_SECONDS", 15.0)
        self.vad_ratio = setting_float("VOICE_VAD_RATIO", 3.0)
        self.vad_min_rms = setting_float("VOICE_VAD_MIN_RMS", 300.0)
        self.whisper_bin = setting("VOICE_WHISPER_BIN", "") or find_whisper_bin()
        self.whisper_model = setting(
            "VOICE_WHISPER_MODEL", str(VOICE_DIR / "models" / "ggml-small.en.bin")
        )
        self.whisper_threads = int(setting_float("VOICE_WHISPER_THREADS", 4))


def find_whisper_bin() -> str:
    found = shutil.which("whisper-cli")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"):
        if os.access(candidate, os.X_OK):
            return candidate
    return ""


# ---- agent endpoint -----------------------------------------------------------

class SpeakingWatcher(threading.Thread):
    """Polls GET /speaking a few times a second.

    `muted()` is true while Jarvis speaks, for a short tail after it stops
    (room echo, the last syllable still in the buffer), and for a moment after
    we hand it a transcript, before its answer has started.
    """

    POLL_S = 0.2
    TAIL_S = 0.6

    def __init__(self, base_url: str) -> None:
        super().__init__(daemon=True, name="speaking")
        self.url = base_url + "/speaking"
        self.speaking = False
        self.reachable: bool | None = None
        self._quiet_after = 0.0
        self._lock = threading.Lock()

    def hold(self, seconds: float) -> None:
        with self._lock:
            self._quiet_after = max(self._quiet_after, time.monotonic() + seconds)

    def muted(self) -> bool:
        with self._lock:
            return self.speaking or time.monotonic() < self._quiet_after

    def poll_once(self) -> None:
        try:
            with urllib.request.urlopen(self.url, timeout=0.5) as resp:
                speaking = bool(json.load(resp).get("speaking"))
            if self.reachable is not True:
                log.info("agent reachable at %s", self.url)
            self.reachable = True
        except (urllib.error.URLError, OSError, ValueError) as err:
            if self.reachable is not False:
                log.warning("can't read %s (%s); treating Jarvis as not speaking", self.url, err)
            self.reachable = False
            speaking = False
        with self._lock:
            if self.speaking and not speaking:
                self._quiet_after = max(self._quiet_after, time.monotonic() + self.TAIL_S)
            self.speaking = speaking

    def run(self) -> None:
        while True:
            self.poll_once()
            time.sleep(self.POLL_S)


def post_transcript(base_url: str, text: str) -> bool:
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        base_url + "/voice",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            log.info("POST /voice -> %s", resp.status)
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as err:
        log.error("POST /voice -> %s", err.code)
    except (urllib.error.URLError, OSError) as err:
        log.error("POST /voice failed: %s", err)
    return False


# ---- wake word ------------------------------------------------------------------

def load_wake_model(name: str):
    from openwakeword.model import Model

    try:
        return Model(wakeword_models=[name], inference_framework="onnx")
    except Exception as err:  # missing files show up as various errors
        raise SystemExit(
            f"can't load openWakeWord model {name!r}: {err}\n"
            "Run voice/setup.sh to download the models."
        ) from err


def wake_score(model, chunk: np.ndarray) -> float:
    scores = model.predict(chunk)
    return max(scores.values()) if scores else 0.0


# ---- audio helpers -------------------------------------------------------------

def rms(chunk: np.ndarray) -> float:
    return float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2))) if chunk.size else 0.0


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.astype(np.int16).tobytes())


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path}: need 16 kHz mono 16-bit")
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def play_chime(path: str) -> None:
    if path and os.path.exists(path):
        subprocess.Popen(["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---- speech to text --------------------------------------------------------------

# whisper.cpp writes these for silence and noise.
_NON_SPEECH = re.compile(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*")


def transcribe(cfg: Config, wav_path: Path) -> str:
    if not cfg.whisper_bin:
        raise RuntimeError("whisper-cli not found (brew install whisper-cpp, or set VOICE_WHISPER_BIN)")
    if not os.path.exists(cfg.whisper_model):
        raise RuntimeError(f"whisper model missing: {cfg.whisper_model} (run voice/setup.sh)")
    cmd = [
        cfg.whisper_bin,
        "-m", cfg.whisper_model,
        "-f", str(wav_path),
        "-l", "en",
        "-t", str(cfg.whisper_threads),
        "--no-timestamps",
        "--no-prints",
    ]
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"whisper-cli exited {proc.returncode}: {proc.stderr.strip()[-500:]}")
    text = " ".join(line.strip() for line in proc.stdout.splitlines())
    text = re.sub(r"\s+", " ", _NON_SPEECH.sub(" ", text)).strip()
    log.info("transcribed in %.1fs: %r", time.monotonic() - t0, text)
    return text


# ---- listening loop ----------------------------------------------------------------

class Mic:
    """16 kHz mono int16 chunks of CHUNK samples, pushed onto a queue."""

    def __init__(self, device: str | None) -> None:
        import sounddevice as sd

        self.q: queue.Queue[np.ndarray] = queue.Queue(maxsize=400)  # ~32 s
        dev: int | str | None = device
        if isinstance(device, str) and device.isdigit():
            dev = int(device)
        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK,
            device=dev,
            callback=self._callback,
        )

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ARG002
        if status:
            log.debug("audio status: %s", status)
        try:
            self.q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass

    def start(self) -> None:
        self.stream.start()

    def read(self) -> np.ndarray:
        return self.q.get()

    def drain(self) -> None:
        while True:
            try:
                self.q.get_nowait()
            except queue.Empty:
                return


def record_utterance(cfg: Config, mic: Mic, watcher: SpeakingWatcher, floor: float) -> np.ndarray | None:
    """Record after the wake word until silence. None if nothing was said or Jarvis spoke."""
    threshold = max(cfg.vad_min_rms, floor * cfg.vad_ratio)
    frames: list[np.ndarray] = []
    started = False
    silent_ms = 0
    elapsed_ms = 0
    ignore_ms = 300  # the chime itself must not count as speech starting
    while True:
        chunk = mic.read()
        if watcher.muted():
            log.info("Jarvis started speaking; dropping the recording")
            return None
        frames.append(chunk)
        elapsed_ms += CHUNK_MS
        loud = rms(chunk) >= threshold
        if loud and elapsed_ms > ignore_ms:
            started = True
            silent_ms = 0
        elif started:
            silent_ms += CHUNK_MS
            if silent_ms >= cfg.silence_ms:
                break
        if not started and elapsed_ms >= cfg.start_timeout_s * 1000:
            log.info("nothing said after the wake word (threshold rms %.0f)", threshold)
            return None
        if elapsed_ms >= cfg.max_seconds * 1000:
            log.info("hit VOICE_MAX_SECONDS; cutting off")
            break
    return np.concatenate(frames)


def listen(cfg: Config) -> None:
    log.info(
        "loading wake model %s (threshold %.2f, %d frame(s))",
        cfg.wake_model, cfg.wake_threshold, cfg.wake_frames,
    )
    model = load_wake_model(cfg.wake_model)
    if not cfg.whisper_bin:
        log.error("whisper-cli not found; wake word works but nothing can be transcribed")
    elif not os.path.exists(cfg.whisper_model):
        log.error("whisper model missing at %s; run voice/setup.sh", cfg.whisper_model)

    watcher = SpeakingWatcher(cfg.base_url)
    watcher.poll_once()
    watcher.start()

    mic = Mic(cfg.input_device)
    mic.start()
    log.info("listening (agent %s)", cfg.base_url)

    floor = cfg.vad_min_rms / cfg.vad_ratio  # noise floor estimate, updated while idle
    hits = 0
    was_muted = False
    zero_chunks = 0
    warned_zero = False

    while True:
        chunk = mic.read()

        # macOS hands a process without Microphone permission all-zero audio.
        if not chunk.any():
            zero_chunks += 1
            if zero_chunks * CHUNK_MS >= 10_000 and not warned_zero:
                log.error(
                    "the mic is silent (all zeros for 10 s). Grant Microphone permission to "
                    "this python in System Settings > Privacy & Security > Microphone."
                )
                warned_zero = True
        else:
            zero_chunks = 0

        if watcher.muted():
            if not was_muted:
                model.reset()  # forget any of Jarvis's own audio already scored
                was_muted = True
            hits = 0
            continue
        if was_muted:
            model.reset()
            was_muted = False

        level = rms(chunk)
        floor = 0.995 * floor + 0.005 * level  # slow average of the room, ~16 s
        score = wake_score(model, chunk)
        hits = hits + 1 if score >= cfg.wake_threshold else 0
        if hits < cfg.wake_frames:
            continue

        log.info("wake word (score %.2f)", score)
        hits = 0
        play_chime(cfg.chime)
        audio = record_utterance(cfg, mic, watcher, floor)
        model.reset()
        if audio is None:
            continue

        with tempfile.TemporaryDirectory(prefix="bab-voice-") as tmp:
            wav = Path(tmp) / "utterance.wav"
            write_wav(wav, audio)
            try:
                text = transcribe(cfg, wav)
            except (RuntimeError, subprocess.TimeoutExpired) as err:
                log.error("transcription failed: %s", err)
                text = ""
        if text:
            # Its answer hasn't started yet when the POST returns; don't wake on it.
            watcher.hold(1.5)
            post_transcript(cfg.base_url, text)
        mic.drain()  # audio queued during transcription is stale


# ---- self test -----------------------------------------------------------------------

def say_to_wav(text: str, out: Path) -> None:
    aiff = out.with_suffix(".aiff")
    subprocess.run(["say", "-o", str(aiff), text], check=True)
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(out)],
        check=True,
    )


def selftest(cfg: Config) -> int:
    ok = True
    print(f"agent endpoint: {cfg.base_url}")
    print(f"wake model:     {cfg.wake_model}, threshold {cfg.wake_threshold}")
    t0 = time.monotonic()
    model = load_wake_model(cfg.wake_model)
    print(f"  loaded in {time.monotonic() - t0:.2f}s")

    silence = np.zeros(SAMPLE_RATE * 2, dtype=np.int16)
    peak_silence = max(wake_score(model, silence[i:i + CHUNK]) for i in range(0, silence.size, CHUNK))
    print(f"  silence: peak score {peak_silence:.3f}")
    if peak_silence >= cfg.wake_threshold:
        print("  FAIL: silence triggers the wake word")
        ok = False

    with tempfile.TemporaryDirectory(prefix="bab-voice-selftest-") as tmp:
        tmpdir = Path(tmp)
        wake_wav = tmpdir / "wake.wav"
        # Pad with silence so the model's feature window fills up.
        say_to_wav("Hey Jarvis", wake_wav)
        samples = np.concatenate([np.zeros(SAMPLE_RATE, np.int16), read_wav(wake_wav), np.zeros(SAMPLE_RATE, np.int16)])
        model.reset()
        scores = [wake_score(model, samples[i:i + CHUNK]) for i in range(0, samples.size - CHUNK + 1, CHUNK)]
        peak = max(scores)
        over = sum(s >= cfg.wake_threshold for s in scores)
        print(f"  say 'Hey Jarvis': peak score {peak:.3f}, {over} frame(s) over threshold"
              " (synthetic voice; informational)")

        command_wav = tmpdir / "command.wav"
        say_to_wav("Hey Jarvis, play some Daft Punk.", command_wav)
        print(f"whisper:        {cfg.whisper_bin or '(whisper-cli not found)'}")
        print(f"  model:        {cfg.whisper_model}{'' if os.path.exists(cfg.whisper_model) else ' (missing)'}")
        if cfg.whisper_bin and os.path.exists(cfg.whisper_model):
            try:
                text = transcribe(cfg, command_wav)
                print(f"  transcript:   {text!r}")
                if "daft" not in text.lower():
                    print("  FAIL: transcript doesn't contain 'Daft'")
                    ok = False
            except (RuntimeError, subprocess.TimeoutExpired) as err:
                print(f"  FAIL: {err}")
                ok = False
        else:
            print("  SKIP transcription (run voice/setup.sh)")

    watcher = SpeakingWatcher(cfg.base_url)
    watcher.poll_once()
    print(f"GET /speaking:  {'reachable, speaking=' + str(watcher.speaking) if watcher.reachable else 'not reachable (agent not running?)'}")
    print("selftest:", "OK" if ok else "FAILED")
    return 0 if ok else 1


def list_devices() -> int:
    import sounddevice as sd

    print(sd.query_devices())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="B@B Jarvis voice daemon")
    parser.add_argument("--selftest", action="store_true", help="check models and whisper without a mic")
    parser.add_argument("--list-devices", action="store_true", help="list audio devices")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    cfg = Config()
    if args.list_devices:
        return list_devices()
    if args.selftest:
        return selftest(cfg)
    try:
        listen(cfg)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
