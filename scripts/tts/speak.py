#!/usr/bin/env python3
"""Worm's voice: Kokoro (an open 82M-parameter text-to-speech model) on this Mac, run by lib/stage/voice.ts.

Reads one JSON object per line on stdin and answers one per line on stdout:

    {"id": 7, "text": "Bob is packed tonight."}   synthesise and play, after anything already queued
    {"warm": ["One sec.", "Checking the music."]} synthesise these now and keep them, so they play at once later
    {"cancel": true}                              stop talking now and drop everything queued

    {"ready": true}  {"started": 7}  {"done": 7}  {"error": "..."}

Lines are synthesised one ahead of playback, so the next sentence is ready when the current one ends. It exits when
stdin closes, so it never outlives the server. Setup: scripts/tts/setup.sh. Voice: STAGE_VOICE (default af_heart).
"""

import json
import os
import queue
import sys
import threading

import sounddevice
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "..", ".data", "tts")
VOICE = os.environ.get("STAGE_VOICE", "").strip() or "af_heart"
SPEED = float(os.environ.get("STAGE_VOICE_SPEED", "1.05"))

kokoro = Kokoro(os.path.join(MODELS, "kokoro-v1.0.onnx"), os.path.join(MODELS, "voices-v1.0.bin"))
if VOICE not in kokoro.get_voices():
    VOICE = "af_heart"

to_synth: "queue.Queue[tuple[int, str]]" = queue.Queue()
to_play: "queue.Queue[tuple[int, object, int]]" = queue.Queue(maxsize=2)
cache: dict = {}
to_warm: list = []
generation = 0
lock = threading.Lock()


def say(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def synthesise(text: str):
    if text in cache:
        return cache[text]
    samples, rate = kokoro.create(text, voice=VOICE, speed=SPEED, lang="en-us")
    return samples, rate


def warm_one() -> None:
    """Synthesise one of the lines to keep ready. Only done while nothing real is waiting to be said."""
    text = to_warm.pop(0)
    if text not in cache:
        cache[text] = synthesise(text)


def synth_loop() -> None:
    while True:
        try:
            line_id, text = to_synth.get(timeout=0.1)
        except queue.Empty:
            if to_warm:
                warm_one()
            continue
        mine = generation
        try:
            samples, rate = synthesise(text)
        except Exception as error:  # A line that cannot be spoken is skipped, not fatal.
            say({"error": str(error)[:200], "done": line_id})
            continue
        if mine == generation:
            to_play.put((line_id, samples, rate))


def play_loop() -> None:
    while True:
        line_id, samples, rate = to_play.get()
        say({"started": line_id})
        sounddevice.play(samples, rate)
        sounddevice.wait()
        say({"done": line_id})


def cancel() -> None:
    global generation
    with lock:
        generation += 1
        for pending in (to_synth, to_play):
            while True:
                try:
                    item = pending.get_nowait()
                except queue.Empty:
                    break
                say({"done": item[0]})
    sounddevice.stop()


def handle(message: dict) -> None:
    if message.get("cancel"):
        cancel()
    elif isinstance(message.get("warm"), list):
        to_warm.extend(text for text in message["warm"] if isinstance(text, str))
    elif isinstance(message.get("text"), str):
        to_synth.put((int(message.get("id", 0)), message["text"]))


threading.Thread(target=synth_loop, daemon=True).start()
threading.Thread(target=play_loop, daemon=True).start()
say({"ready": True, "voice": VOICE})
for raw in sys.stdin:
    try:
        handle(json.loads(raw))
    except (ValueError, TypeError):
        continue
