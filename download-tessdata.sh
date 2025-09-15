#!/usr/bin/env bash
# Download tessdata_best language files to ./tessdata (requires wget)
# WARNING: This can be large if you request many languages.
set -e
mkdir -p tessdata
LANGS="$1"
if [ -z "$LANGS" ]; then
  echo "Usage: $0 eng spa deu fra por rus jpn chi_sim ... (space separated)"
  exit 1
fi
BASE=https://github.com/tesseract-ocr/tessdata_best/raw/main
for L in $LANGS; do
  echo "Downloading $L..."
  wget -q -O tessdata/${L}.traineddata ${BASE}/${L}.traineddata || { echo "Failed $L"; }
done
echo "done. tessdata files in ./tessdata"
