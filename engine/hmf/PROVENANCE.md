# Provenance of Sagebrush's Hilbert modular forms

Sagebrush's Hilbert modular forms over $F = \mathbb{Q}(\sqrt{5})$ may be
ported from `psage/modform/hilbert/sqrt5`, part of PSAGE
(https://github.com/williamstein/psage). That code computes weight-2
Hilbert modular forms by the icosian method: the icosian ring, a maximal
order in the definite quaternion algebra over $F$ ramified only at the two
infinite places, acting on $\mathbb{P}^1(\mathcal{O}_F/\mathfrak{N})$, with
Hecke operators from local splittings of the algebra.

William Stein is the sole author and copyright holder of every file in
`psage/modform/hilbert/sqrt5` (2010–2011). He wrote it himself, by reading
the published literature and implementing the algorithm independently. It
was distributed in PSAGE under the GNU GPL, version 3 or later.

On 2026-10-14 William Stein gave permission for that code to be ported to
Sagebrush and licensed under Sagebrush's license, MIT OR Apache-2.0.

The rest of this engine (other fields, other weights, the definite and
indefinite methods in general) is written from the literature, under
CONTRIBUTING.md's clean-room rule. Each part says where it comes from.
