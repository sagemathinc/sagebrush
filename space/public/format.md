# The space format (`*.space.json`), for agents

A space is a board in 3D: notes, code with its output, files and 3D plots, placed by their links and groups. In the Sagebrush agents chat, a file you write whose name ends in `.space.json` (with `workspace_write`) opens beside the chat as a 3D space the person can fly through, search, and click. You write the structure, not the geometry: the viewer lays it out.

```json
{
  "format": "sagebrush-space",
  "version": 1,
  "title": "Modular forms in Sagebrush",
  "nodes": [
    { "id": "overview", "kind": "note", "title": "Start here", "group": "notes", "text": "# Markdown\n\nWith $\\LaTeX$." },
    { "id": "modsym/lib.rs", "kind": "file", "title": "modsym/src/lib.rs", "group": "modsym", "lang": "rust", "text": "the file's text (or its first 200 lines)", "lines": 812 },
    { "id": "hecke", "kind": "code", "title": "Hecke polynomial", "group": "samples", "lang": "sage", "near": "modsym/lib.rs",
      "text": "M = ModularSymbols(43)\nprint(M.hecke_polynomial(2).factor())", "output": "(x - 3) * (x + 2)^2 * (x^2 - 2)^2" },
    { "id": "dims", "kind": "plot3d", "title": "dim S_k(Γ0(N))", "group": "samples", "lang": "sage",
      "text": "x, y = var('x y')\nplot3d(sin(x)*cos(y), (x,-3,3), (y,-3,3))",
      "surface": { "x": [0, 1, 2], "y": [0, 1], "z": [[0, 1, 0], [1, 2, 1]] } }
  ],
  "edges": [ { "from": "hecke", "to": "modsym/lib.rs" }, { "from": "overview", "to": "hecke" } ],
  "selected": null
}
```

## Objects (`nodes`)

- `id` (required, unique), `kind`, `title`, `text`.
- `kind`:
  - `note`: a thick board; `text` is Markdown, with math.
  - `file`: a source file; `text` is its code, highlighted by `lang` (`rust`, `python`, `typescript`, `javascript`, `json`, `matlab`); `lines` is its length.
  - `code`: code the person can edit and run in the browser; `lang` is the language it runs in: `python`, `sage`, `matlab` or `magma`. Give `output` (text) if you know it; otherwise the person presses Run.
  - `plot3d`: a 3D plot shown as a real object. Give `text` (Sage code making a 3D plot, which runs and replaces the object) and, so something shows before it runs, an optional `surface`: `x` and `y` are the grid's values, and `z[j][i]` is the height over `x[i]`, `y[j]`.
- `group`: objects of a group cluster together, in one color, with the group's name above them from afar. Use groups for directories, crates, modules or topics.
- `near`: another object's id; this one is placed beside it (a sample beside the code it illustrates).
- Don't give `position`: the layout is computed and is the same each time for the same file.

Sage 3D graphics that run in the space (checked Nov 20 2026; each becomes the object): `plot3d`, `parametric_plot3d`, `implicit_plot3d`, `spherical_plot3d`, `cylindrical_plot3d`, `revolution_plot3d`, `sphere`, `cube`, `tetrahedron`, `octahedron`, `icosahedron`, `dodecahedron`, `point3d`, `line3d`, `arrow3d`, `polygon3d`, `text3d`, sums of these (`P + Q`), and the options `color=` (names such as 'seagreen', or 'rainbow' as a colormap), `opacity=`, `mesh=`, `frame=`. Not yet: `list_plot3d`, and `polytopes.X().plot()`.

Notes are Markdown with math (`$...$`, `$$...$$`) typeset by KaTeX; raw HTML is limited to formatting, and pictures from other sites aren't shown.

## What each object is for: `summary`

Give every object a `summary`: one to three sentences on what it is *for* (a file's purpose and its key functions, named as in the code), not a restatement of its text. It is drawn on the object's face, readable from a distance, and at the top of the drawer, so a person learns the shape of the whole before reading any code. Math in `$...$`. For a file, also give `lines` (its length): its slab grows with it.

## Guided tours: `tours`

```json
"tours": [ { "id": "click", "title": "How a click becomes a flight",
  "steps": [ { "node": "picking", "text": "It starts with the mouse: …" }, { "node": "flying", "text": "…" } ] } ]
```

A tour is a path through objects in an order that teaches, each stop with a few sentences of narration: what to notice there, and how it leads to the next. The person picks a tour and goes Next / Back (in a headset too). Three or four tours of four to seven stops are a good start for a codebase. Use real function names.

## Links (`edges`)

`{ "from": id, "to": id }`: imports, calls, "illustrates", "explains". Linked objects are pulled together, and an object's links are listed and clickable when the person reads it.

## What the person selected: `selected`

When the person clicks an object, its `id` is written into the file as `"selected"` (null when nothing is). Read the file with `workspace_read` to see what they are looking at ("this", "the selected one"). Keep `selected` as you read it when you write the file again, and write with the revision you read as `base`: a click since then makes the write refuse, so read again and redo it.

## Tips

- Write the whole space in one `workspace_write` (a few hundred objects are fine). To change it, read it, change the JSON, and write it back: the person's camera and selection stay where they are.
- For a codebase: one `file` object per file (its text, or its first 200 lines) with its `summary` and `lines`, `group` = its directory or crate, an edge per import or `use`, a `note` per directory or crate explaining it, a few runnable `code` samples `near` what they illustrate, and a few `tours`. A long file can be several objects, one per part.
