#!/bin/bash
# Sets up the voice daemon: voice/.venv, the openWakeWord models, whisper.cpp
# and the ggml-small.en model in voice/models/. Safe to run again.
#
#   voice/setup.sh             everything
#   voice/setup.sh --no-brew   don't install whisper-cpp, just say how
#   voice/setup.sh --no-model  skip the 466 MB whisper model download
#
# Python: $VOICE_PYTHON, else the first of python3.12, 3.11, 3.10, python3.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
venv="$dir/.venv"
models="$dir/models"
model_file="$models/ggml-small.en.bin"
model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"

no_brew=0
no_model=0
for arg in "$@"; do
  case "$arg" in
    --no-brew) no_brew=1 ;;
    --no-model) no_model=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done

# ---- python + packages -------------------------------------------------------
pick_python() {
  if [[ -n "${VOICE_PYTHON:-}" ]]; then
    printf '%s' "$VOICE_PYTHON"
    return
  fi
  local p
  for p in python3.12 python3.11 python3.10 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 python3; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(not ((3, 10) <= sys.version_info[:2] <= (3, 13)))' 2>/dev/null; then
      command -v "$p"
      return
    fi
  done
  return 1
}

if [[ ! -x "$venv/bin/python" ]]; then
  if ! py="$(pick_python)"; then
    echo "Need Python 3.10-3.13: brew install python@3.12" >&2
    exit 1
  fi
  echo "+ $py -m venv $venv"
  "$py" -m venv "$venv"
fi
echo "+ pip install -r voice/requirements.txt"
"$venv/bin/python" -m pip install -q --upgrade pip
"$venv/bin/python" -m pip install -q -r "$dir/requirements.txt"

echo "+ downloading openWakeWord models (hey_jarvis, melspectrogram, embedding)"
"$venv/bin/python" - <<'PY'
import openwakeword.utils as u
u.download_models(["hey_jarvis"])
PY

# ---- whisper.cpp -------------------------------------------------------------
whisper="$(command -v whisper-cli || true)"
[[ -z "$whisper" && -x /opt/homebrew/bin/whisper-cli ]] && whisper=/opt/homebrew/bin/whisper-cli
if [[ -z "$whisper" ]]; then
  if [[ $no_brew -eq 0 ]] && command -v brew >/dev/null 2>&1; then
    echo "+ brew install whisper-cpp"
    brew install whisper-cpp
    whisper="$(command -v whisper-cli || echo /opt/homebrew/bin/whisper-cli)"
  else
    echo "whisper-cli is not installed. Install it with:  brew install whisper-cpp"
    echo "(Homebrew's build uses Metal on Apple silicon.)"
  fi
else
  echo "whisper-cli: $whisper"
fi

# ---- ggml-small.en -------------------------------------------------------------
mkdir -p "$models"
if [[ -s "$model_file" ]]; then
  echo "whisper model: $model_file"
elif [[ $no_model -eq 1 ]]; then
  echo "skipping the model; to get it later: curl -fL -o '$model_file' '$model_url'"
else
  echo "+ downloading ggml-small.en (466 MB) to $model_file"
  curl -fL --retry 3 -o "$model_file.part" "$model_url"
  mv "$model_file.part" "$model_file"
fi

echo
echo "Done. Check it with:  $dir/run.sh --selftest"
echo "Then install the service:  scripts/install.sh --only voice"
