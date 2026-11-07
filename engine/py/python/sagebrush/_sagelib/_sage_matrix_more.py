"""Matrix work loaded on first use rather than at Sage's start: the
refusals of the generalized eigenproblem A v = lambda B v."""


def refuse_generalized(m):
    """Sage's refusal over an exact ring (it solves the problem over RDF and
    CDF only)."""
    raise NotImplementedError("generalized eigenvector decomposition is implemented for RDF and CDF, but not for %s" % (m.base_ring(),))


def refuse_generalized_numeric():
    """Over RDF and CDF, where Sage solves it by LAPACK: not here yet (B was
    ignored before, a wrong answer).

    EXAMPLES::

        sage: for K in [RDF, CDF]:  # sagebrush only (Sage solves these by LAPACK)
        ....:     A = matrix(K, [[1, 0], [0, 2]]); B = 2*identity_matrix(K, 2)
        ....:     calls = [("eigenvalues(B)", lambda: A.eigenvalues(B)),
        ....:              ("eigenvectors_right(B)", lambda: A.eigenvectors_right(B)),
        ....:              ("eigenvectors_left(B)", lambda: A.eigenvectors_left(B)),
        ....:              ("eigenvectors_left(other=B)", lambda: A.eigenvectors_left(other=B)),
        ....:              ("eigenmatrix_right(B)", lambda: A.eigenmatrix_right(B))]
        ....:     for name, f in calls:
        ....:         try:
        ....:             f()
        ....:             print(K, name, "answered")
        ....:         except NotImplementedError as e:
        ....:             print(K, name, e)
        Real Double Field eigenvalues(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Real Double Field eigenvectors_right(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Real Double Field eigenvectors_left(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Real Double Field eigenvectors_left(other=B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Real Double Field eigenmatrix_right(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Complex Double Field eigenvalues(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Complex Double Field eigenvectors_right(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Complex Double Field eigenvectors_left(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Complex Double Field eigenvectors_left(other=B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
        Complex Double Field eigenmatrix_right(B) the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet
    """
    raise NotImplementedError("the generalized eigenvalue problem (other=B) over RDF and CDF is not available in sagebrush yet")
