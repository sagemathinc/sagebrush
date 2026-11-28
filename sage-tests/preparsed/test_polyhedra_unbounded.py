# Generated from ../test_polyhedra_unbounded.sage by Sage's preparser (run_cpython.py --regen).
_sage_const_1 = Integer(1); _sage_const_0 = Integer(0); _sage_const_2 = Integer(2); _sage_const_5 = Integer(5); _sage_const_3 = Integer(3); _sage_const_10 = Integer(10); _sage_const_7 = Integer(7); _sage_const_6 = Integer(6)# Unbounded, lower-dimensional and empty polyhedra (equality, extreme rays,
# faces, interiors, volume, bounding box) and the GRS error-erasure decoder's
# erasure budget, against Sage.

def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))

# equality keeps the direction of lineality
dirs = [[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ], [_sage_const_1 , _sage_const_1 ], [_sage_const_1 , -_sage_const_1 ]]
Ls = [Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[d]) for d in dirs]
print([[int(A == B) for B in Ls] for A in Ls])
print([[int(A != B) for B in Ls] for A in Ls])
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_2 , _sage_const_0 ]]) == Polyhedron(vertices=[[_sage_const_5 , _sage_const_0 ]], lines=[[-_sage_const_1 , _sage_const_0 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_1 , _sage_const_0 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_1 ]], lines=[[_sage_const_1 , _sage_const_0 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_0 , _sage_const_2 ], [_sage_const_3 , _sage_const_0 ], [_sage_const_1 , _sage_const_1 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[-_sage_const_1 , _sage_const_0 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_1 , _sage_const_0 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]], lines=[[_sage_const_0 , _sage_const_1 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_3 ]], rays=[[_sage_const_1 , _sage_const_1 ]], lines=[[_sage_const_0 , -_sage_const_1 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]) == Polyhedron(vertices=[[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ], [_sage_const_0 , _sage_const_0 ], [_sage_const_1 /_sage_const_3 , _sage_const_1 /_sage_const_3 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_1 , _sage_const_1 ]]))
print(Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]) == Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ]]))

# extreme rays are kept
for P in [Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ], [_sage_const_2 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_1 , _sage_const_2 , _sage_const_3 ]], rays=[[_sage_const_0 , _sage_const_0 , _sage_const_1 ]])]:
    print(P.vertices_list(), P.rays_list(), P.is_compact(), P.is_lattice_polytope(), P.contains([_sage_const_10 ] + [_sage_const_0 ] * (P.ambient_dim() - _sage_const_1 )))

# faces of unbounded polyhedra (no faces at infinity); the graph of the bounded part
unb = [Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]], lines=[[_sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_0 , _sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_0 , _sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_0 , _sage_const_1 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_1 , _sage_const_0 ]]),
       Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]),
       Polyhedron(vertices=[[_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_1 , _sage_const_0 ]])]
for P in unb:
    G = P.graph()
    print(P.f_vector(), G.order(), G.size(), [[f.ambient_V_indices() for f in P.faces(k)] for k in range(P.dim())])
print(polytopes.hypercube(_sage_const_3 ).f_vector(), polytopes.hypercube(_sage_const_3 ).graph().size())

# the interiors of the empty polyhedron are empty
for n in [_sage_const_1 , _sage_const_2 , _sage_const_3 ]:
    E = Polyhedron(ambient_dim=n)
    print(E.contains([_sage_const_0 ] * n), E.interior_contains([_sage_const_0 ] * n), E.relative_interior_contains([_sage_const_0 ] * n))
T = Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_2 , _sage_const_0 ], [_sage_const_0 , _sage_const_2 ]])
print(T.interior_contains([_sage_const_1 /_sage_const_2 , _sage_const_1 /_sage_const_2 ]), T.relative_interior_contains([_sage_const_1 /_sage_const_2 , _sage_const_1 /_sage_const_2 ]))

# volume: a lower-dimensional set has volume 0, bounded or not
for P in [Polyhedron(vertices=[[_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_0 , _sage_const_1 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]),
          Polyhedron(lines=[[_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]),
          Polyhedron(ambient_dim=_sage_const_2 ),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]])]:
    show(P.volume)

# bounding boxes exist only for polytopes
for P in [Polyhedron(vertices=[[_sage_const_1 , _sage_const_0 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], lines=[[_sage_const_1 , _sage_const_0 ]]),
          Polyhedron(ambient_dim=_sage_const_2 ),
          Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ], [_sage_const_1 , _sage_const_0 ], [_sage_const_0 , _sage_const_1 ]]),
          Polyhedron(vertices=[[_sage_const_1 /_sage_const_2 , _sage_const_0 ], [_sage_const_0 , _sage_const_3 /_sage_const_2 ]])]:
    show(P.bounding_box)
show(lambda: Polyhedron(vertices=[[_sage_const_1 /_sage_const_2 , _sage_const_0 ], [_sage_const_0 , _sage_const_3 /_sage_const_2 ]]).bounding_box(integral=True))
show(lambda: Polyhedron(vertices=[[_sage_const_0 , _sage_const_0 ]], rays=[[_sage_const_1 , _sage_const_0 ]]).bounding_box(integral=True))

# the error-erasure decoder needs k surviving evaluations
from copy import copy
F = GF(_sage_const_7 )
C = codes.GeneralizedReedSolomonCode([F(i) for i in range(_sage_const_6 )], _sage_const_2 )
D = C.decoder('ErrorErasure')
c = C.encode(vector(F, [_sage_const_3 , _sage_const_5 ]))
for ne in range(_sage_const_7 ):
    e = vector(GF(_sage_const_2 ), [_sage_const_1 ] * ne + [_sage_const_0 ] * (_sage_const_6  - ne))
    for nerr in range(_sage_const_3 ):
        r = copy(c)
        for j in range(nerr):
            r[_sage_const_5  - j] += _sage_const_1
        print(ne, nerr, end=" ")
        show(lambda: D.decode_to_message((r, e)))
e = vector(GF(_sage_const_2 ), [_sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_0 ])
show(lambda: D.decode_to_message((vector(F, [_sage_const_0 ] * _sage_const_6 ), e)))
show(lambda: D.decode_to_code((vector(F, [_sage_const_0 ] * _sage_const_6 ), e)))
C3 = codes.GeneralizedReedSolomonCode([F(i) for i in range(_sage_const_1 , _sage_const_7 )], _sage_const_3 , [F(_sage_const_2 )] * _sage_const_6 )
D3 = C3.decoder('ErrorErasure')
w = C3.encode(vector(F, [_sage_const_1 , _sage_const_2 , _sage_const_3 ]))
for e in [vector(GF(_sage_const_2 ), [_sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_0 , _sage_const_0 , _sage_const_0 ]), vector(GF(_sage_const_2 ), [_sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_1 , _sage_const_0 , _sage_const_0 ]), vector(GF(_sage_const_2 ), [_sage_const_0 , _sage_const_1 , _sage_const_0 , _sage_const_1 , _sage_const_0 , _sage_const_1 ])]:
    show(lambda: D3.decode_to_message((w, e)))