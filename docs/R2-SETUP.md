# Hosting the history tiles on Cloudflare R2

GitHub Pages caps a single file at **100 MB**, which limits the self-hosted
PMTiles archive to **maxzoom 6** (80 MB). Cloudflare R2 has no such cap and
**zero egress fees**, and PMTiles fetches only the byte ranges a viewer actually
looks at — so a larger, higher-detail archive costs the same per view. This is
how to serve the **maxzoom 8** archive (209 MB) instead.

Measured trade-off (same input, same flags, only maxzoom differs):

| maxzoom | size | z0 world tile | where it can live |
|---|---|---|---|
| 6 | 80 MB | 52,876 features | GitHub Pages (current) |
| 7 | 124 MB | 52,850 features | R2 |
| **8** | **209 MB** | **52,806 features** | **R2 (this guide)** |
| 10 | 837 MB | 52,817 features | R2 (rebuild if you want it) |

The archive to upload is built at `world-historical-z8.pmtiles` in the repo root
(git-ignored). Rebuild any zoom with
`ZOOMS='10' LIMIT_MB=999 OUT=/path/out.pmtiles bash scripts/build-tiles.sh compile`.

---

## 1. Create the bucket (you — needs your Cloudflare login)

1. Sign in to the Cloudflare dashboard and open **R2**.
2. **Create bucket**, e.g. `history-map-tiles`. Any region.
3. Upload the archive. Dashboard drag-and-drop works, or with
   [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/):

   ```bash
   wrangler r2 object put history-map-tiles/world-historical.pmtiles \
     --file world-historical-z8.pmtiles \
     --content-type application/octet-stream
   ```

   (Object key `world-historical.pmtiles` — the maxzoom is in the file, not the name.)

## 2. Make it public and get the URL

Either option gives a stable HTTPS URL:

- **r2.dev subdomain** (quickest): bucket → **Settings** → **Public access** →
  enable the `r2.dev` URL. You get
  `https://pub-<hash>.r2.dev/world-historical.pmtiles`.
- **Custom domain** (recommended for production): **Settings** → **Custom
  domains** → add e.g. `tiles.yourdomain.com`. URL becomes
  `https://tiles.yourdomain.com/world-historical.pmtiles`.

## 3. CORS (required — the app fetches cross-origin with Range)

Bucket → **Settings** → **CORS policy** → add:

```json
[
  {
    "AllowedOrigins": ["https://skyzz3r.github.io"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

Add `http://localhost:5173` to `AllowedOrigins` too if you want to test the R2
archive from the dev server. Without CORS the app silently falls back to the
bundled z6 file, then to OHM's gated tiles — it will not break, just not use R2.

## 4. Point the app at it

Set a **repository variable** (not a secret — the URL is public):
GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
**Variables** → **New** → name `OHM_R2_URL`, value the full URL from step 2.

`deploy.yml` already passes it as `VITE_OHM_R2_URL` into the Vite build, and
`src/sources.ts` prefers it (at minzoom 0) over the bundled file.

For local testing, create `.env.local`:

```
VITE_OHM_R2_URL=https://pub-<hash>.r2.dev/world-historical.pmtiles
```

## 5. Deploy

Push to `main` (or run **Deploy to Pages** manually). Confirm in the browser's
Network tab: requests go to your R2 URL as **206 Partial Content**, and the map
draws below zoom 5.

---

### Keep the bundled z6 as a safety net

The app falls back R2 → bundled file → hosted. That bundled fallback is whatever
sits on the orphan `tiles` branch. Make sure it holds the **good z6 archive**
(80 MB, z0 = 52,876) and not an older broken build, or a failed R2 fetch lands
on a blank map. Rebuild it with `bash scripts/build-tiles.sh` and let the
**Build history tiles** workflow publish it, or force-push it to `tiles`
directly. See the memory note on the `tiles` branch going live on any push.
