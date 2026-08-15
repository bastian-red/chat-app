#!/usr/bin/env bash
#
# Build assets/demo.gif for the README from the screenshots the E2E "demo" spec
# captures.
#
# Contract with e2e/tests/demo.spec.ts: it writes one PNG per demo step into
# e2e/demo-shots/, named so that plain lexical sort is playback order -- a numeric
# prefix (01-sign-in.png, 02-channel.png, ...) is what that means in practice. This
# script does not invent an order of its own; it trusts `sort`. e2e/demo-shots/ is
# gitignored (see .gitignore) because it is regenerated output, not source -- only
# the GIF this script produces from it is committed.
#
# What the demo has to show, and why it constrains this script: the product's
# claim is that a message sent in one window appears in another, in order. A
# single-viewport capture cannot show that, so demo.spec.ts screenshots TWO browser
# contexts stacked in one image. That makes the frames taller than a normal page
# shot and makes the padding step below load-bearing rather than defensive.
#
# Two tools, two different jobs, and both matter:
#   ImageMagick `convert` -- Playwright's screenshots are only guaranteed
#     identical in width (the viewport); a step with more content than another is
#     a taller full-page screenshot. ffmpeg's image2 demuxer assembles a single
#     video stream and does not accept a frame size change mid-stream, so every
#     frame is padded to the tallest frame's canvas first.
#   ffmpeg -- palette generation (`palettegen`/`paletteuse`) and the actual GIF
#     encode. A GIF is a 256-colour format; encoding UI screenshots through
#     ffmpeg's default palette (fixed, generic) bands every soft shadow and
#     gradient. A generated, image-specific palette is the difference between a
#     legible screenshot and a posterised one.
#
# Usage:
#   ./scripts/demo-gif.sh
#     Captures the frames and builds the GIF. One command, on purpose.
#   CAPTURE=0 ./scripts/demo-gif.sh
#     Rebuild the GIF from whatever is already in e2e/demo-shots/, for tuning
#     FRAME_SECONDS or GIF_WIDTH without paying for a browser run each time.
#
# Env overrides (all optional):
#   FRAME_SECONDS   How long each screenshot holds on screen. Default 1.5.
#   GIF_WIDTH       Output width in pixels; height scales to match. Default 1000.
#   MAX_BYTES       Refuse to write a GIF larger than this. Default 8388608
#                   (8 MiB): GitHub soft-warns past 10 MiB, and a README asset
#                   that large slows every clone and every page load.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FRAMES_DIR="$ROOT/e2e/demo-shots"
OUT_DIR="$ROOT/assets"
OUT_FILE="$OUT_DIR/demo.gif"

FRAME_SECONDS="${FRAME_SECONDS:-1.5}"
GIF_WIDTH="${GIF_WIDTH:-1000}"
MAX_BYTES="${MAX_BYTES:-8388608}"

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

# --- Tools --------------------------------------------------------------
#
# Checked up front: the failure mode without this check is a cryptic "command not
# found" fifty lines into a pipeline, on whichever of the two runs first, on a
# machine where it is genuinely not obvious which package provides `convert`.
command -v ffmpeg >/dev/null 2>&1 ||
  die "ffmpeg is not installed. Debian/Ubuntu: sudo apt-get install -y ffmpeg"
command -v convert >/dev/null 2>&1 ||
  die "ImageMagick's 'convert' is not installed. Debian/Ubuntu: sudo apt-get install -y imagemagick"

# --- Input --------------------------------------------------------------
#
# Captured here rather than assumed, unless CAPTURE=0. One command producing the
# GIF is the difference between a README asset that is regenerated when the UI
# changes and one that quietly shows last month's design: a two-step ritual is a
# step somebody skips.
#
# DEMO=1 is what un-ignores demo.spec.ts (see testIgnore in
# e2e/playwright.config.ts). Without it the spec is skipped, e2e.sh exits 0, and
# this script would then fail on an empty directory for a reason that looks
# nothing like the cause.
CAPTURE="${CAPTURE:-1}"
if [[ "$CAPTURE" == "1" ]]; then
  echo "==> Capturing frames: DEMO=1 ./scripts/e2e.sh demo.spec.ts"
  rm -rf "$FRAMES_DIR"
  # One browser, not both. The suite runs Chromium and Firefox, and without this
  # the capture happens twice: the second project overwrites the first project's
  # frames, and -- because both runs post into a channel with the same name against
  # the same database -- the second one finds the first one's messages already
  # there and sends its own again below them. A GIF assembled from two engines
  # interleaved would be nonsense even if it worked.
  DEMO=1 "$ROOT/scripts/e2e.sh" --project=chromium demo.spec.ts ||
    die "the demo capture failed. Run it directly to see why: DEMO=1 ./scripts/e2e.sh --project=chromium demo.spec.ts"
fi

[[ -d "$FRAMES_DIR" ]] ||
  die "$FRAMES_DIR does not exist. Generate it first: DEMO=1 ./scripts/e2e.sh demo.spec.ts"

mapfile -t FRAMES < <(find "$FRAMES_DIR" -maxdepth 1 -type f -iname '*.png' | sort)
[[ ${#FRAMES[@]} -gt 0 ]] ||
  die "$FRAMES_DIR exists but contains no .png files. Generate it first: DEMO=1 ./scripts/e2e.sh demo.spec.ts"

echo "==> ${#FRAMES[@]} frame(s) found in ${FRAMES_DIR#"$ROOT"/}, in this order:"
printf '      %s\n' "${FRAMES[@]##*/}"

# --- Work in an isolated temp dir ----------------------------------------
#
# "write only into assets/" means every intermediate file -- the padded frames,
# the generated palette, the GIF before it has passed the size check -- lives
# under a mktemp directory the trap below always removes, success or failure.
# Nothing but the final assets/demo.gif ever lands in the repo tree.
WORK="$(mktemp -d -t chat-demo-gif.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PADDED_DIR="$WORK/padded"
PALETTE="$WORK/palette.png"
STAGED_GIF="$WORK/demo.gif"
mkdir -p "$PADDED_DIR"

# --- Normalise canvas size ------------------------------------------------
#
# Read every frame's dimensions in one ImageMagick call rather than one process
# per frame, then pad each onto a canvas matching the tallest frame (white
# background, top-anchored) so ffmpeg's image2 demuxer sees one consistent frame
# size for the whole sequence -- the requirement `convert` above exists to
# satisfy.
read -r MAX_W MAX_H < <(
  identify -format '%w %h\n' "${FRAMES[@]}" |
    awk '{ if ($1 > w) w = $1; if ($2 > h) h = $2 } END { print w, h }'
)
[[ -n "$MAX_W" && -n "$MAX_H" ]] || die "could not read frame dimensions with 'identify'."
echo "==> Padding every frame to ${MAX_W}x${MAX_H}"

i=0
for frame in "${FRAMES[@]}"; do
  i=$((i + 1))
  padded="$(printf '%s/frame-%04d.png' "$PADDED_DIR" "$i")"
  convert "$frame" -background white -gravity north -extent "${MAX_W}x${MAX_H}" "$padded"
done

# --- Palette-optimised encode ---------------------------------------------
#
# Two ffmpeg passes sharing one filter chain (scale to GIF_WIDTH, keeping aspect
# ratio; `-2` rounds the height to the nearest even number, which some GIF viewers
# require and none reject): `palettegen` builds a palette from the actual frames
# rather than ffmpeg's generic default, and `paletteuse` re-renders through it.
# Skipping this step is the single biggest quality/size lever for a GIF of UI
# screenshots -- the default palette bands soft shadows and anti-aliased text into
# visible blocks.
FRAMERATE="$(awk -v s="$FRAME_SECONDS" 'BEGIN { printf "%.6f", 1 / s }')"
SCALE_FILTER="scale=${GIF_WIDTH}:-2:flags=lanczos"

echo "==> Generating the palette"
ffmpeg -y -loglevel error -framerate "$FRAMERATE" -i "$PADDED_DIR/frame-%04d.png" \
  -vf "${SCALE_FILTER},palettegen=stats_mode=diff" "$PALETTE"

echo "==> Encoding the GIF (${GIF_WIDTH}px wide, ${FRAME_SECONDS}s per frame)"
ffmpeg -y -loglevel error -framerate "$FRAMERATE" -i "$PADDED_DIR/frame-%04d.png" -i "$PALETTE" \
  -lavfi "${SCALE_FILTER}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 "$STAGED_GIF"

[[ -s "$STAGED_GIF" ]] || die "ffmpeg reported success but wrote no bytes to ${STAGED_GIF}."

# --- Size budget ----------------------------------------------------------
#
# Refusing at 8 MiB catches a regression (a frame count spike, a dropped palette
# step) before it reaches a commit rather than after someone notices the repo got
# heavy. Two stacked browser contexts per frame makes this budget tighter here
# than in a single-viewport demo, which is why the ceiling is enforced rather than
# suggested.
BYTES="$(stat --format=%s "$STAGED_GIF" 2>/dev/null || stat -f%z "$STAGED_GIF")"
MB="$(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b / 1048576 }')"

if [[ "$BYTES" -gt "$MAX_BYTES" ]]; then
  die "assets/demo.gif would be ${MB} MiB, over the ${MAX_BYTES}-byte budget. " \
    "Reduce FRAME_SECONDS, GIF_WIDTH, or the number of frames demo.spec.ts captures."
fi

mkdir -p "$OUT_DIR"
mv "$STAGED_GIF" "$OUT_FILE"

echo
echo "PASS: wrote ${OUT_FILE#"$ROOT"/} (${MB} MiB, ${#FRAMES[@]} frames, budget ${MAX_BYTES} bytes)."
