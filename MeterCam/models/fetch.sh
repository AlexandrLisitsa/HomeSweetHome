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

# Each model with the SHA-256 of the copy that reads the meter in production
# (taken from LXC 104 on 2026-10-04). Upstream is a branch, not a release, so
# the checksum is what pins it: if jomjol ever replaces a file, the fetch
# fails here instead of quietly changing how the dial is read. To move to a
# new model on purpose, update its line.
MODELS="
a8d78fa79da699c88da6e43663548bce433d4b1e78c0f35678d9c17a4ee5d43b dig-class100-0180-s2-q.tflite
78f8ee04f8e195ef9e8e1314c77690d530ef151e24c1cf7ab3c66055d0c2b950 dig-class100-0182-s2_q.tflite
e1e3d55153c05df8297d1ff24d3cd1a4d3bc4dbefd0ddd0c9a31b6252721205f dig-class11_1910_s2_q.tflite
8f719c03e69d077809ac8bb20d2f79e73172eac652b18dc8d021952b68262a58 dig-cont_0900_s3_q.tflite
"

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

failed=0
echo "$MODELS" | while read -r want m; do
    [ -n "$m" ] || continue
    if [ -f "$m" ]; then
        if [ "$(sha "$m")" = "$want" ]; then
            echo "have    $m"
        else
            echo "WRONG   $m is here but is not the pinned model (sha256 differs)" >&2
            exit 1
        fi
        continue
    fi
    echo "fetch   $m"
    if ! curl -fsSL -o "$m.part" "$BASE/$m"; then
        echo "FAILED  $m -- check the filename against $BASE" >&2
        rm -f "$m.part"
        exit 1
    fi
    if [ "$(sha "$m.part")" != "$want" ]; then
        echo "FAILED  $m -- downloaded, but not the pinned model (sha256 $(sha "$m.part"))" >&2
        rm -f "$m.part"
        exit 1
    fi
    mv "$m.part" "$m"
done || failed=1

if [ "$failed" -ne 0 ]; then
    echo >&2
    echo "not every model is in place -- see above" >&2
    exit 1
fi
echo
echo "all models present and matching their pinned sha256"
