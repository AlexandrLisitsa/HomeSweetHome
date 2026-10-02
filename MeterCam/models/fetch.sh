#!/bin/sh
# Download the digit models. Run once, from anywhere:
#
#     sh models/fetch.sh
#
# The weights are NOT committed. jomjol's repositories carry no stated licence,
# so vendoring someone else's trained network into this one is a question nobody
# needs to answer -- fetching them at setup time leaves them exactly where they
# came from. If the upstream files move, this script is the only thing to fix.
#
# Which model to use, in config.json:
#
#   dig-class100-*   100 classes, one per tenth of a drum revolution. THE ONE
#                    TO USE. A drum halfway between 6 and 7 reads 6.5, and that
#                    fraction is what service/reader.py's carry rule needs to
#                    decide the drum to its left. Also gives the last drum real
#                    sub-digit resolution, which on this meter is 0.0001 m3.
#
#   dig-class11-*    0-9 plus an explicit "cannot tell". Coarser: a drum between
#                    positions comes back as unreadable rather than as 6.5, so
#                    frames get rejected where class100 would have read them.
#                    Worth trying if class100 misbehaves on this dial.
#
#   dig-cont-*       Continuous angle, no confidence score at all. reader.py
#                    supports it, the gate cannot check confidence with it.
#
set -eu

# Write next to this script, not into whoever's working directory invoked it.
# Without this, `sh models/fetch.sh` from the module root silently drops four
# .tflite files in the root -- where .gitignore's `models/*.tflite` does not
# cover them, and where the container's /models mount cannot see them.
cd "$(dirname "$0")"

BASE="https://raw.githubusercontent.com/jomjol/AI-on-the-edge-device/main/sd-card/config"

MODELS="
dig-class100-0180-s2-q.tflite
dig-class100-0182-s2_q.tflite
dig-class11_1910_s2_q.tflite
dig-cont_0900_s3_q.tflite
"

for m in $MODELS; do
    if [ -f "$m" ]; then
        echo "have    $m"
        continue
    fi
    echo "fetch   $m"
    if ! curl -fsSL -o "$m.part" "$BASE/$m"; then
        echo "FAILED  $m -- check the filename against $BASE" >&2
        rm -f "$m.part"
        continue
    fi
    mv "$m.part" "$m"
done

echo
echo "--- sizes and checksums, so a truncated download is visible ---"
for m in $MODELS; do
    [ -f "$m" ] || continue
    size=$(wc -c < "$m" | tr -d ' ')
    # A few hundred KB is right. A file of 9 bytes is GitHub's 404 page.
    if [ "$size" -lt 10000 ]; then
        echo "SUSPECT $m is only ${size} bytes -- almost certainly not a model" >&2
    fi
    printf '%8s  %s\n' "$size" "$(sha256sum "$m" 2>/dev/null | cut -c1-16) $m"
done
