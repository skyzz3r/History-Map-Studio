#!/usr/bin/env bash
# Build world-historical.pmtiles from the OpenHistoricalMap planet dump.
#
# NOT run by default, and not needed to run the app: OHM already serves these
# tiles at vtiles.openhistoricalmap.org with CORS open to our origin, and
# src/map.ts points there. Build this only if you want to self-host, pin a
# version, or work offline.
#
# Requires osmium-tool and tippecanoe. Neither has a Windows build, so on
# Windows run this inside WSL:
#   sudo apt install osmium-tool tippecanoe
# Budget ~30 GB of free scratch space; the GeoJSON stage is far larger than
# the compressed input.
set -euo pipefail

BUCKET="https://s3.amazonaws.com/planet.openhistoricalmap.org"
OUT="${OUT:-public/basemaps/world-historical.pmtiles}"
WORK="${WORK:-./.tilework}"
mkdir -p "$WORK" "$(dirname "$OUT")"

# 1. Fetch the newest planet dump (~1.1 GB, rebuilt daily).
if [ ! -f "$WORK/planet.osm.pbf" ]; then
  KEY=$(curl -s "$BUCKET?list-type=2&max-keys=1000&prefix=planet/planet" \
        | tr '>' '>\n' | grep -oE 'Key>planet/planet-[0-9_]+\.osm\.pbf' \
        | sed 's/^Key>//' | sort | tail -1)
  echo "==> fetching $KEY"
  curl -# -o "$WORK/planet.osm.pbf" "$BUCKET/$KEY"
fi

# 2. Keep only administrative boundaries.
#
# NOT `historic=yes`: that tag appears on exactly ONE administrative boundary in
# all of OHM (checked via Overpass). Everything in OHM is historic by
# definition, so filtering on it yields an empty extract. This filter keeps
# ~182k features, ~96k of which carry start_date.
echo "==> osmium tags-filter"
osmium tags-filter --overwrite -o "$WORK/filtered.osm.pbf" \
  "$WORK/planet.osm.pbf" wr/boundary=administrative

# 3. PBF -> GeoJSONSeq. tippecanoe cannot read .osm.pbf; its inputs are
#    GeoJSON, GeoJSONSeq, FlatGeobuf and CSV. Without this stage step 4 fails.
echo "==> osmium export"
osmium export --overwrite -f geojsonseq \
  --attributes=id,type -o "$WORK/borders.geojsonseq" "$WORK/filtered.osm.pbf"

# 4. Dates -> numbers. MapLibre expressions cannot compare "1942-05-12"
#    mathematically, and a missing date must become a sentinel rather than null:
#    null fails every numeric comparison and would silently hide the feature.
echo "==> numeric dates"
node --experimental-strip-types scripts/decimal-dates.mjs \
  < "$WORK/borders.geojsonseq" > "$WORK/borders-dated.geojsonseq"

# 5. Compile. -zg picks the zoom range; --drop-densest-as-needed keeps dense
#    areas from blowing the per-tile limit.
echo "==> tippecanoe"
tippecanoe -o "$OUT" --force -zg --drop-densest-as-needed \
  -l boundaries "$WORK/borders-dated.geojsonseq"

SIZE=$(du -m "$OUT" | cut -f1)
echo "==> $OUT is ${SIZE} MB"
[ "$SIZE" -gt 100 ] && cat <<'WARN'
!! Over 100 MB: GitHub Pages rejects files that large, so this cannot ship in
!! the repo. Either host it on R2/S3 and point BASEMAP_OHM at that, or keep
!! using OHM's own tile server (the current default).
WARN
exit 0
