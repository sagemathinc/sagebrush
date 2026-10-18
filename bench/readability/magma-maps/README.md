# Magma maps readability slice

Scope: the maps section in `lib/_magma.py`, from `_struct_name` through `Image`.
The owner reserved this region; collection, arithmetic and vector changes are outside it.

The frozen key contains ten questions with three criteria each. The shared
`../run.py` runs each question in three separate cold Haiku processes against a
read-only source projection of the exact commit. Only `lib/_magma.py` is visible;
the answer key, reports, repository history and memory notes are absent.

```sh
python3 bench/readability/run.py --repo . --sha b1859ef4 \
  --key bench/readability/magma-maps/questions.json \
  --out /path/to/before --work /path/to/empty-work --claude /opt/cocalc/bin2/claude
```

`corpus.py` generates fixed cases without randomness. They include the existing
stdin maps fixture, rules and compositions, graph validation errors, partial
maps, set lifting, universe conversion, inverses and callback traces. Run it on
a VM after building the CLI, first without `--baseline`, then with the saved
baseline. It compares the case list, source, stdout, stderr, exit code and timeout
status exactly; only elapsed time is excluded. Expected failures are retained.
This checks behavior preservation, not correctness against an external oracle.

```sh
python3 bench/readability/magma-maps/corpus.py --repo . --out /path/to/before.json
python3 bench/readability/magma-maps/corpus.py --repo . --out /path/to/after.json \
  --baseline /path/to/before.json
```
