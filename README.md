# Interactive History Map

Scrub world borders from 123,000 BC to 2010, click a polity for its Wikidata/Wikipedia
context at that date, and record camera keyframes into a playable sequence you can
export as a PNG.

```bash
npm install
npm run dev     # localhost:5173
npm test        # asserts on the date/bearing math
npm run build   # tsc --noEmit && vite build
```

## How it works

- **Basemap** — [Protomaps](https://protomaps.com) planet PMTiles over HTTP range
  requests, so a ~137 GB archive costs a few KB per view. Styled dark via
  `@protomaps/basemaps`, with roads, buildings, POIs and present-day boundaries
  filtered out so nothing contradicts the era on screen.
- **Borders** — [Historical-Basemaps](https://github.com/aourednik/historical-basemaps),
  53 discrete year snapshots. The timeline indexes *snapshots*, not years, so the
  slider spends its travel where the data is dense rather than on prehistory.
  Adjacent snapshots crossfade while scrubbing.
- **Context** — Wikidata `wbsearchentities` → entity JSON → Wikipedia REST summary.
  All CORS-open, so there is no server. Leader/population claims are filtered
  client-side against the year using their P580/P582 qualifiers.
- **Scrubbing** — the slider is uncontrolled and writes straight to deck.gl props
  and one text node. Dragging it triggers zero React re-renders.

## Known limits

- The Protomaps basemap is **hotlinked from their daily build**, which their docs
  advise against for anything but testing. For real use, copy a `.pmtiles` extract
  to your own storage and change `BUCKET` in `src/map.ts`.
- Snapshot years are sparse and irregular, so the crossfade reads as a dissolve
  rather than borders morphing. Fixing that means CShapes 2.0 (which has real
  start/end dates) plus deck.gl's `DataFilterExtension`.
- Entity lookup takes the first search hit, so ambiguous names can resolve to the
  wrong Wikidata item ("Prussia" → the region, not the Kingdom).

Border data is CC-BY-SA via Historical-Basemaps; basemap © OpenStreetMap contributors.
