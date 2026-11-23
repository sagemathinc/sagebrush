# TikZ pictures against TikZ itself

The LaTeX preview draws a `tikzpicture` itself (`web/latex/engine/tikz.mjs`), as
an SVG. This benchmark draws the pictures of `pictures.json` both ways and
compares them. It is run by hand or nightly, not in a PR's CI. Its unit tests,
which are in CI, are `web/latex/test-latex-tikz.mjs`.

```
node bench/latex/tikz/run.mjs [--only T01,T02] [--out DIR] [--keep]
```

It needs `pdflatex` with TikZ, `pdftoppm` and Chrome (`CHROME`, default
`chromium`). Results go to `bench/latex/results/DATE-tikz/`: `results.json` (every
number) and `table.md`.

## What it compares

- **TeX:** every picture is a page of one `standalone` document with no border,
  so a page is exactly the picture's bounding box. pdflatex writes each box to
  its log, and `pdftoppm` rasters each page at 300 dpi.
- **The preview:** `renderTikz` draws each picture alone on a page of a
  headless Chrome, which takes a screenshot at the same scale, cropped to the
  picture's box.
  - The preview writes TeX's pt as CSS pt (1/72 in, not 1/72.27). Its pictures
    are 0.375% larger than TeX's on the page, as the rest of the preview's
    lengths are, so the scale takes that out.
- **The box:** its width and height must be within 3% of TeX's.
- **The ink:** any pixel visibly not white, as an IoU. It is reported raw, and
  again after widening both sides by 0.24 pt (2 px).
  - The widening is needed because two rasterizers don't agree where a thin
    stroke's antialiased edge falls, or how dark it is: pdftoppm draws a
    0.4 pt line solid, Chrome spreads it.
  - A picture passes if its widened IoU is at least its own `iou`, or 0.8
    without one. A picture's own `iou` is recorded with its reason (`why`).

The pictures were written for this benchmark. They are paths, styles,
transforms and `\foreach`; nodes come in the next round.
