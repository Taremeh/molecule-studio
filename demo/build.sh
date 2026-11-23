#!/bin/sh
# Builds the demo video: narration → word times → screen recording → music and mix → MP4.
#
#   sh demo/build.sh <build-dir> [<essay-video-dir>]
#
# The narration uses the Kokoro voice pipeline of the "When We No Longer Need to Understand"
# videos (tts.py / align.py, voice af_heart): pass its video folder as the second argument
# (default: ../when-we-no-longer-need-to-understand/video). Its .venv provides Python and ffmpeg.
# The app must be served at http://localhost:4173 (npm run build && npx vite preview --port 4173).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
ESS="${2:-$HERE/../../when-we-no-longer-need-to-understand/video}"
PY="$ESS/.venv/bin/python"
FFMPEG="$("$PY" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"

# the voice tools are copied next to the build, so their line cache stays out of the essay folder
mkdir -p "$OUT/tools"
cp "$ESS/tts.py" "$ESS/loudness.py" "$ESS/align.py" "$ESS/drama.py" "$OUT/tools/"
(cd "$OUT/tools" && "$PY" -I tts.py --models "$ESS/models" --script "$HERE/narration.json" --out "$OUT")
(cd "$OUT/tools" && HF_HUB_OFFLINE=1 "$PY" -I align.py "$OUT")

node "$HERE/record.mjs" --timeline "$OUT/timeline.json" --out "$OUT"
"$PY" -I "$HERE/music.py" "$OUT"

"$FFMPEG" -y -loglevel error -f concat -safe 0 -i "$OUT/frames.txt" -i "$OUT/mix.wav" \
  -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -shortest "$OUT/molecule-studio-demo.mp4"
echo "wrote $OUT/molecule-studio-demo.mp4"
