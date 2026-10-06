# Contributing to Sagebrush

Sagebrush is MIT OR Apache-2.0 (see [NOTICE.md](NOTICE.md)). Keeping it that
way is the point of the project, so contributions follow two rules.

## 1. Clean room

Do not read, translate or copy the source code of GPL (or other copyleft or
closed) systems such as PARI, Sage, FLINT, NTL or Magma when writing code for
Sagebrush. Using them from the outside is fine and encouraged: as oracles in
tests, as benchmarks, and their documentation and published papers.

Implement from the literature (papers, books) or from code under a permissive
license (keeping its notice in [NOTICE.md](NOTICE.md)), or with the copyright
owner's written permission (record it, as in
[engine/ap/PROVENANCE.md](engine/ap/PROVENANCE.md)). Say in a comment where
an algorithm comes from.

## 2. Developer Certificate of Origin

Every commit must be signed off, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that
you wrote the change or otherwise have the right to submit it under the
project's license. Add the line with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in Sagebrush, as defined in the Apache-2.0 license,
is dual licensed as MIT OR Apache-2.0, without any additional terms or
conditions. Copyright in Sagebrush as a whole is held by SageMath, Inc.;
contributors keep the copyright in their contributions.

## Tests

Results are checked against independent systems wherever possible: Sage and
Magma output byte for byte, PARI for class groups, NumPy for numpy. See the
"Tests" section of the [README](README.md).
