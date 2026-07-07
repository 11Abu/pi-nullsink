# assets

`demo.gif` — the README hero. It's **generated, not hand-captured**, so it stays truthful as the UI
changes.

## Regenerate

```sh
brew install vhs        # one-time (also pulls ttyd + ffmpeg)
bun run demo:record     # runs scripts/demo/demo.tape → assets/demo.gif
```

The recording is driven by [`scripts/demo/hub-demo.ts`](../scripts/demo/hub-demo.ts): a self-driving
tour through the **real** hub renderer (`renderHub` / `reduceHub`) against fixture data — no pi
runtime, no network, no real money or keys. Every frame is byte-for-byte what the shipped hub draws;
only the keystrokes and the top-up progression are scripted.

Preview the scenes as static frames, without recording:

```sh
DEMO_STILL=1 bun run scripts/demo/hub-demo.ts
```

Tune the look (size, font, framerate) in [`demo.tape`](../scripts/demo/demo.tape); tune the tour
(scenes, timing) in the harness. `assets/` is not shipped in the npm package — npm renders the GIF
from the GitHub repo.

## Logo

- `og.png` — the nullsink brand card (1200×630), for social / Open Graph previews.
- `banner.png` — the README banner, derived from `og.png` with the dark canvas removed and trimmed:

  ```sh
  magick og.png -alpha set -fuzz 12% -fill none -draw "alpha 0,0 floodfill" -trim +repage banner.png
  ```

  A corner flood-fill (not a global color-to-transparent) is deliberate: it removes only the outer
  canvas and keeps the wordmark's internal dark pixels, so "nullsink" stays readable dark-on-lime on
  both light and dark themes.
