# Unbounded, lower-dimensional and empty polyhedra (equality, extreme rays,
# faces, interiors, volume, bounding box) and the GRS error-erasure decoder's
# erasure budget, against Sage.

def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))

# equality keeps the direction of lineality
dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
Ls = [Polyhedron(vertices=[[0, 0]], lines=[d]) for d in dirs]
print([[int(A == B) for B in Ls] for A in Ls])
print([[int(A != B) for B in Ls] for A in Ls])
print(Polyhedron(vertices=[[0, 0]], lines=[[2, 0]]) == Polyhedron(vertices=[[5, 0]], lines=[[-1, 0]]))
print(Polyhedron(vertices=[[0, 0]], lines=[[1, 0]]) == Polyhedron(vertices=[[0, 1]], lines=[[1, 0]]))
print(Polyhedron(vertices=[[0, 0]], rays=[[1, 0], [0, 1]]) == Polyhedron(vertices=[[0, 0]], rays=[[0, 2], [3, 0], [1, 1]]))
print(Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]) == Polyhedron(vertices=[[0, 0]], rays=[[-1, 0]]))
print(Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]) == Polyhedron(vertices=[[0, 0]], lines=[[1, 0]]))
print(Polyhedron(vertices=[[0, 0]], rays=[[1, 0]], lines=[[0, 1]]) == Polyhedron(vertices=[[0, 3]], rays=[[1, 1]], lines=[[0, -1]]))
print(Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]) == Polyhedron(vertices=[[1, 0], [0, 1], [0, 0], [1/3, 1/3]]))
print(Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]) == Polyhedron(vertices=[[0, 0], [1, 0], [1, 1]]))
print(Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]) == Polyhedron(vertices=[[0, 0], [1, 0]]))

# extreme rays are kept
for P in [Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]),
          Polyhedron(vertices=[[0, 0, 0]], rays=[[1, 0, 0], [0, 1, 0]]),
          Polyhedron(vertices=[[0, 0], [1, 0]], rays=[[1, 0]]),
          Polyhedron(vertices=[[0, 0]], rays=[[1, 0], [2, 0]]),
          Polyhedron(vertices=[[1, 2, 3]], rays=[[0, 0, 1]])]:
    print(P.vertices_list(), P.rays_list(), P.is_compact(), P.is_lattice_polytope(), P.contains([10] + [0] * (P.ambient_dim() - 1)))

# faces of unbounded polyhedra (no faces at infinity); the graph of the bounded part
unb = [Polyhedron(vertices=[[0, 0], [1, 0]], rays=[[0, 1]]),
       Polyhedron(vertices=[[0, 0]], rays=[[1, 0], [0, 1]]),
       Polyhedron(vertices=[[0, 0]], rays=[[1, 0]], lines=[[0, 1]]),
       Polyhedron(vertices=[[0, 0, 0], [1, 0, 0]], lines=[[0, 0, 1]]),
       Polyhedron(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], rays=[[0, 0, 1]]),
       Polyhedron(vertices=[[0, 0, 0]], rays=[[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
       Polyhedron(vertices=[[0, 0]], lines=[[1, 0]]),
       Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]),
       Polyhedron(vertices=[[1, 0, 0], [0, 1, 0]], rays=[[1, 1, 0]])]
for P in unb:
    G = P.graph()
    print(P.f_vector(), G.order(), G.size(), [[f.ambient_V_indices() for f in P.faces(k)] for k in range(P.dim())])
print(polytopes.hypercube(3).f_vector(), polytopes.hypercube(3).graph().size())

# the interiors of the empty polyhedron are empty
for n in [1, 2, 3]:
    E = Polyhedron(ambient_dim=n)
    print(E.contains([0] * n), E.interior_contains([0] * n), E.relative_interior_contains([0] * n))
T = Polyhedron(vertices=[[0, 0], [2, 0], [0, 2]])
print(T.interior_contains([1/2, 1/2]), T.relative_interior_contains([1/2, 1/2]))

# volume: a lower-dimensional set has volume 0, bounded or not
for P in [Polyhedron(vertices=[[1, 0, 0], [0, 1, 0]], rays=[[1, 1, 0]]),
          Polyhedron(vertices=[[0, 0]], lines=[[1, 0]]),
          Polyhedron(vertices=[[0, 0]], lines=[[0, 1]]),
          Polyhedron(vertices=[[0, 0]], rays=[[1, 0], [0, 1]]),
          Polyhedron(lines=[[1, 0], [0, 1]]),
          Polyhedron(ambient_dim=2),
          Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]])]:
    show(P.volume)

# bounding boxes exist only for polytopes
for P in [Polyhedron(vertices=[[1, 0, 0], [0, 1, 0]], rays=[[1, 1, 0]]),
          Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]),
          Polyhedron(vertices=[[0, 0]], lines=[[1, 0]]),
          Polyhedron(ambient_dim=2),
          Polyhedron(vertices=[[0, 0], [1, 0], [0, 1]]),
          Polyhedron(vertices=[[1/2, 0], [0, 3/2]])]:
    show(P.bounding_box)
show(lambda: Polyhedron(vertices=[[1/2, 0], [0, 3/2]]).bounding_box(integral=True))
show(lambda: Polyhedron(vertices=[[0, 0]], rays=[[1, 0]]).bounding_box(integral=True))

# the error-erasure decoder needs k surviving evaluations
from copy import copy
F = GF(7)
C = codes.GeneralizedReedSolomonCode([F(i) for i in range(6)], 2)
D = C.decoder('ErrorErasure')
c = C.encode(vector(F, [3, 5]))
for ne in range(7):
    e = vector(GF(2), [1] * ne + [0] * (6 - ne))
    for nerr in range(3):
        r = copy(c)
        for j in range(nerr):
            r[5 - j] += 1
        print(ne, nerr, end=" ")
        show(lambda: D.decode_to_message((r, e)))
e = vector(GF(2), [1, 1, 1, 1, 1, 0])
show(lambda: D.decode_to_message((vector(F, [0] * 6), e)))
show(lambda: D.decode_to_code((vector(F, [0] * 6), e)))
C3 = codes.GeneralizedReedSolomonCode([F(i) for i in range(1, 7)], 3, [F(2)] * 6)
D3 = C3.decoder('ErrorErasure')
w = C3.encode(vector(F, [1, 2, 3]))
for e in [vector(GF(2), [1, 1, 1, 0, 0, 0]), vector(GF(2), [1, 1, 1, 1, 0, 0]), vector(GF(2), [0, 1, 0, 1, 0, 1])]:
    show(lambda: D3.decode_to_message((w, e)))
