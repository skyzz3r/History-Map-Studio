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

# 1. Newest planet dump (~1.14 GB, rebuilt daily).
#
# The bucket listing is PAGINATED: a single max-keys request returns a stale
# newest key (it reported a 2023 file when the real newest was today's), so
# follow the continuation token to the end.
if [ ! -f "$WORK/planet.osm.pbf" ]; then
  echo "==> finding newest planet"
  TOKEN=""; KEY=""
  while :; do
    RESP=$(curl -s "$BUCKET?list-type=2&max-keys=1000&prefix=planet/planet${TOKEN}")
    FOUND=$(printf '%s' "$RESP" | tr '>' '>\n' \
            | grep -oE 'Key>planet/planet-[0-9_]+\.osm\.pbf' \
            | sed 's/^Key>//' | sort | tail -1)
    [ -n "$FOUND" ] && KEY="$FOUND"
    NEXT=$(printf '%s' "$RESP" | grep -oE '<NextContinuationToken>[^<]+' | sed 's/.*>//')
    [ -z "$NEXT" ] && break
    TOKEN="&continuation-token=$(printf '%s' "$NEXT" | sed 's/+/%2B/g; s|/|%2F|g; s/=/%3D/g')"
  done
  [ -n "$KEY" ] || { echo "!! could not find a planet dump"; exit 1; }
  echo "==> fetching $KEY"
  curl -# -o "$WORK/planet.osm.pbf" "$BUCKET/$KEY"
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
# The pipe matters. Writing filtered.osm.pbf and then a planet-wide GeoJSON
# needed ~30 GB of scratch; osmium streams one stage into the next, so only the
# boundary subset ever touches disk. tippecanoe cannot read .osm.pbf, so the
# export stage is required either way.
if [ ! -f "$WORK/prepared.geojsonseq" ]; then
  echo "==> filter + export + prepare (streamed)"
  osmium tags-filter -o - -f pbf "$WORK/planet.osm.pbf" \
    wr/boundary=administrative,political,military \
    wr/military=occupation_zone \
    wr/border_type=demilitarized_zone \
    | osmium export -f geojsonseq --attributes=id,type - \
    | node --experimental-strip-types scripts/prepare.mjs \
    > "$WORK/prepared.geojsonseq"
fi
echo "==> prepared $(du -m "$WORK/prepared.geojsonseq" | cut -f1) MB"

# 4. Compile, stepping the maxzoom down until it fits.
#
# Output size cannot be known before building, and silently shipping a truncated
# tileset would look like missing data. So try the best zoom first and SAY which
# one we landed on.
#   -P   parallel input (the RS-separated stream allows it)
#   -Z0  keep tiles all the way out to the world view: this is the zoom gate
#        being removed, and label points carry minzoom 0 from prepare.mjs
FINAL_Z=""
for Z in 12 10 8; do
  echo "==> tippecanoe -z$Z"
  tippecanoe -o "$OUT" --force -P -Z0 -z"$Z" \
    --drop-densest-as-needed --no-tile-size-limit \
    "$WORK/prepared.geojsonseq"
  SIZE=$(du -m "$OUT" | cut -f1)
  echo "==> z$Z -> ${SIZE} MB"
  if [ "$SIZE" -le "$LIMIT_MB" ]; then FINAL_Z="$Z"; break; fi
  echo "!! over ${LIMIT_MB} MB, retrying at a lower maxzoom"
done

if [ -z "$FINAL_Z" ]; then
  cat <<WARN
!! Could not fit under ${LIMIT_MB} MB even at z8.
!! GitHub Pages will reject this file. Options: host it on Cloudflare R2 (free
!! tier, CORS configurable) and point OHM_TILES at that, or narrow the extract
!! (e.g. admin_level<=4). Leaving the z8 build in place for inspection.
WARN
  exit 1
fi

echo "===================================================="
echo "  $OUT"
echo "  $(du -m "$OUT" | cut -f1) MB, zoom 0-${FINAL_Z}"
[ "$FINAL_Z" -lt 12 ] && echo "  NOTE: capped at z$FINAL_Z to fit; detail above that zoom is lost."
echo "===================================================="
