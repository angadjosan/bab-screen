#!/bin/sh
# Sets up Worm's voice (scripts/tts/speak.py): a Python environment with Kokoro in .data/tts-venv, and the model
# files (about 350 MB) in .data/tts. Run once from the repository's root: sh scripts/tts/setup.sh
set -eu

RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

python3 -m venv .data/tts-venv
.data/tts-venv/bin/pip install --quiet --upgrade pip
.data/tts-venv/bin/pip install --quiet kokoro-onnx soundfile sounddevice

mkdir -p .data/tts
for file in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s ".data/tts/$file" ] || curl -fL --progress-bar -o ".data/tts/$file" "$RELEASE/$file"
done
echo "Worm's voice is set up. Restart the server to use it."
