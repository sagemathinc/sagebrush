"""Matrix work loaded on first use rather than at Sage's start: the
refusals of the generalized eigenproblem A v = lambda B v."""


def refuse_generalized(m):
    """Sage's refusal over an exact ring (it solves the problem over RDF and
    CDF only)."""
    raise NotImplementedError("generalized eigenvector decomposition is implemented for RDF and CDF, but not for %s" % (m.base_ring(),))


def refuse_generalized_numeric():
    """Over RDF and CDF, where Sage solves it by LAPACK: not here yet (B was
    ignored before, a wrong answer)."""
    raise NotImplementedError("the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet")
