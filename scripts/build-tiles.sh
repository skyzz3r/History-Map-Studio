#!/usr/bin/env bash
# Build world-historical.pmtiles from the OpenHistoricalMap planet dump.
#
# Normally run in CI (.github/workflows/tiles.yml), not by hand: it needs
# osmium-tool and tippecanoe, neither of which has a Windows build.
#
# Why self-host at all: OHM's hosted tiles ship ~300 name_* localisations per
# feature with no per-zoom simplification, so a z3 tile is 4.7 MB and the app
# has to gate itself to zoom 5+. Stripping those fields and letting tippecanoe
# simplify per zoom is what removes the gate.
set -euo pipefail

BUCKET="https://s3.amazonaws.com/planet.openhistoricalmap.org"
OUT="${OUT:-public/basemaps/world-historical.pmtiles}"
WORK="${WORK:-./.tilework}"
# GitHub Pages refuses files over 100 MB, and the app reads this file from the
# same origin, so it has to fit. 95 leaves headroom.
LIMIT_MB="${LIMIT_MB:-95}"
mkdir -p "$WORK" "$(dirname "$OUT")"

# Run #3 sat inside this script for over two hours with no output at all, so
# there was no way to tell osmium's area assembly apart from tippecanoe, or
# either from a hang. Every stage announces itself with a wall clock and an
# elapsed count from here on.
T0=$(date +%s)
say() { printf '==> [%s, +%dm] %s\n' "$(date -u +%H:%M:%S)" "$((($(date +%s) - T0) / 60))" "$*"; }

# Optional stage: "prepare" stops after prepared.geojsonseq, "compile" assumes
# it exists. Splitting the two lets CI cache the expensive half BETWEEN them —
# a cache action's post step never runs when a job is killed for timeout, so
# without an explicit save point in the middle, a run that dies in tippecanoe
# throws away the download, the filter and the export as well.
#
# Every stage is already guarded by "if the output file is missing", so running
# the whole script twice is a no-op on the parts that finished.
STAGE="${1:-all}"

# 1. Newest planet dump (~1.14 GB, rebuilt daily).
#
# The bucket listing is PAGINATED: a single max-keys request returns a stale
# newest key (it reported a 2023 file when the real newest was today's), so
# follow the continuation token to the end.
if [ ! -f "$WORK/planet.osm.pbf" ]; then
  say "finding newest planet"
  #
  # Every test below is a full if/then and every grep ends in `|| true`. That is
  # not style. Under `set -e`, a bare `[ cond ] && action` is a STATEMENT whose
  # exit status is the test's, so it aborts the script whenever the condition is
  # false — `[ -z "$NEXT" ] && break` killed the very first run here after page
  # one, in 0s, printing nothing at all. `grep` exiting 1 on no-match does the
  # same through pipefail.
  TOKEN=""; KEY=""; PAGE=0
  while :; do
    PAGE=$((PAGE + 1))
    if ! RESP=$(curl -sS --retry 3 --retry-delay 2 --max-time 120 \
                 "$BUCKET?list-type=2&max-keys=1000&prefix=planet/planet${TOKEN}"); then
      echo "!! listing page $PAGE failed (curl exit $?)"; exit 1
    fi
    FOUND=$(printf '%s' "$RESP" | grep -oE 'planet/planet-[0-9_]+\.osm\.pbf' \
            | sort | tail -1 || true)
    if [ -n "$FOUND" ]; then KEY="$FOUND"; fi
    NEXT=$(printf '%s' "$RESP" | grep -oE '<NextContinuationToken>[^<]+' \
           | sed 's/.*>//' || true)
    echo "    page $PAGE: newest so far ${KEY:-none}"
    if [ -z "$NEXT" ]; then break; fi
    TOKEN="&continuation-token=$(printf '%s' "$NEXT" | sed 's/+/%2B/g; s|/|%2F|g; s/=/%3D/g')"
  done
  if [ -z "$KEY" ]; then
    echo "!! no planet dump in the listing; first 400 bytes of the last page:"
    printf '%s' "$RESP" | head -c 400; echo
    exit 1
  fi
  say "fetching $KEY"
  # Silent: the progress bar emitted 200 lines of hashes into the CI log and
  # buried the only messages worth reading.
  curl -sS --retry 3 -o "$WORK/planet.osm.pbf" "$BUCKET/$KEY"
  say "downloaded $(du -m "$WORK/planet.osm.pbf" | cut -f1) MB"
fi

# 2+3. Filter to boundaries and convert to GeoJSONSeq, STREAMED.
#
# NOT `historic=yes`: that tag is on exactly ONE administrative boundary in all
# of OHM (checked via Overpass). Everything in OHM is historic by definition.
#
# `wr/` and not `w/`: administrative boundaries in OHM are RELATIONS. A ways-only
# filter drops nearly all of them.
#
# The non-administrative classes are cheap and nearly empty today — measured via
# Overpass: boundary=military 3, boundary=political 14, military=occupation_zone
# 0, border_type=demilitarized_zone 0. They are in the extract so the occupation
# overlay has somewhere to draw from when OHM tagging catches up.
#
# The filter output goes to a FILE, not a pipe.
#
# `osmium export` cannot consume a pipe here for two independent reasons: it
# cannot sniff the format of stdin ("When reading from STDIN you need to use the
# --input-format/-F option"), and assembling boundary relations into polygons
# needs more than one look at the data, which a pipe cannot give.
#
# The thing worth avoiding was never this file — it is the planet-wide GeoJSON,
# which needed ~30 GB. The filtered PBF is only the boundary subset, so it is at
# most as big as the 1.14 GB planet and usually far smaller. The export -> node
# -> file stage stays a pipe, which is where the space actually went.
if [ ! -f "$WORK/prepared.geojsonseq" ]; then
  if [ ! -f "$WORK/bounds.osm.pbf" ]; then
    say "filter to boundaries"
    osmium tags-filter --overwrite -o "$WORK/bounds.osm.pbf" -f pbf \
      "$WORK/planet.osm.pbf" \
      wr/boundary=administrative,political,military \
      wr/military=occupation_zone \
      wr/border_type=demilitarized_zone
  fi
  say "filtered $(du -m "$WORK/bounds.osm.pbf" | cut -f1) MB"

  say "export + prepare"
  osmium export "$WORK/bounds.osm.pbf" -f geojsonseq --attributes=id,type \
    | node --experimental-strip-types scripts/prepare.mjs \
    > "$WORK/prepared.geojsonseq"
fi
PREPARED_LINES=$(wc -l < "$WORK/prepared.geojsonseq")
say "prepared $(du -m "$WORK/prepared.geojsonseq" | cut -f1) MB, $PREPARED_LINES features"
# tippecanoe is perfectly happy to build an empty tileset, and an empty tileset
# looks exactly like "the app cannot reach the tiles". Fail here instead.
if [ "$PREPARED_LINES" -lt 1000 ]; then
  echo "!! implausibly few features — refusing to publish an empty tileset"
  exit 1
fi

if [ "$STAGE" = "prepare" ]; then
  say "stage 'prepare' complete"
  exit 0
fi

# 4. Compile, stepping the maxzoom down until it fits.
#
# Output size cannot be known before building, and silently shipping a truncated
# tileset would look like missing data. So try the best zoom first and SAY which
# one we landed on.
#   -P   parallel input (the RS-separated stream allows it)
#   -Z0  keep tiles all the way out to the world view: this is the zoom gate
#        being removed, and label points carry minzoom 0 from prepare.mjs
#
# The ladder starts at 10, not 12. z12 was aspirational and never once
# completed: run #3 spent two and a half hours in "Reordering geometry" and
# reached 3%. Administrative borders do not carry z12 detail worth the cost,
# and the point of this whole exercise is removing a zoom-5 floor — z10 clears
# that by five levels. MapLibre overzooms past the maximum, so the borders stay
# on screen above it, just not more finely drawn.
#
# `-l boundaries` names the DEFAULT layer. Per-feature "tippecanoe":{"layer":...}
# directives from prepare.mjs still win, but run #3 logged `using name
# "preparedgeojsonseq"` — so without this, anything missing a directive lands in
# a layer named after the input file, which no style references.
FINAL_Z=""
for Z in 10 8 6; do
  say "tippecanoe -z$Z"
  tippecanoe -o "$OUT" --force -P -Z0 -z"$Z" -l boundaries \
    --drop-densest-as-needed --no-tile-size-limit \
    "$WORK/prepared.geojsonseq"
  SIZE=$(du -m "$OUT" | cut -f1)
  say "z$Z -> ${SIZE} MB"
  if [ "$SIZE" -le "$LIMIT_MB" ]; then FINAL_Z="$Z"; break; fi
  echo "!! over ${LIMIT_MB} MB, retrying at a lower maxzoom"
done

if [ -z "$FINAL_Z" ]; then
  cat <<WARN
!! Could not fit under ${LIMIT_MB} MB even at z6.
!! GitHub Pages will reject this file. Options: host it on Cloudflare R2 (free
!! tier, CORS configurable) and point OHM_TILES at that, or narrow the extract
!! (e.g. admin_level<=4). Leaving the z6 build in place for inspection.
WARN
  exit 1
fi

echo "===================================================="
echo "  $OUT"
echo "  $(du -m "$OUT" | cut -f1) MB, zoom 0-${FINAL_Z}"
# if/then, not `&&`: at z12 the test is false, and under `set -e` that would
# fail the job on the last line after a completely successful build.
if [ "$FINAL_Z" -lt 10 ]; then
  echo "  NOTE: capped at z$FINAL_Z to fit; detail above that zoom is lost."
fi
echo "===================================================="
