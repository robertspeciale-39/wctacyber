#!/usr/bin/env bash
# Regenerate the hero frame sequences from a source video.
# Usage:  ./regenerate-frames.sh path/to/new-video.mp4
#
# If you change the frame COUNTS below, update the matching numbers in
# index.html — search for:  var SET = small ? { dir: "assets/seq-sm/", n: 65 }
set -euo pipefail
SRC="${1:?usage: regenerate-frames.sh <video.mp4>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

rm -rf "$HERE/seq" "$HERE/seq-sm"
mkdir -p "$HERE/seq" "$HERE/seq-sm"

# Desktop: every 2nd frame @1600px
ffmpeg -v error -i "$SRC" -vf "select='not(mod(n\,2))',scale=1600:-2" -vsync 0 \
  -c:v libwebp -quality 78 -compression_level 6 -an "$HERE/seq/f_%03d.webp" -y

# Mobile: every 3rd frame @720px
ffmpeg -v error -i "$SRC" -vf "select='not(mod(n\,3))',scale=720:-2" -vsync 0 \
  -c:v libwebp -quality 72 -compression_level 6 -an "$HERE/seq-sm/f_%03d.webp" -y

# Poster (reduced-motion + social preview)
ffmpeg -v error -i "$SRC" -frames:v 1 -vf scale=1600:-2 "$HERE/poster.webp" -y

echo "desktop frames: $(ls "$HERE/seq" | wc -l)"
echo "mobile frames:  $(ls "$HERE/seq-sm" | wc -l)"
