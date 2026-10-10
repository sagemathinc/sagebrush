import json
out = open("eisenstein_new_dims.jsonl", "w")
def tr(f):
    try: return int(f())
    except Exception as e: return "ERR"
for N in range(1, 61):
    for k in (2, 4, 6, 8):
        M = ModularForms(N, k)
        out.write(json.dumps([int(N), int(k), tr(lambda: M.eisenstein_subspace().new_subspace().dimension()), tr(lambda: M.new_subspace().dimension()), tr(lambda: M.cuspidal_subspace().new_subspace().dimension()), tr(lambda: M.eisenstein_subspace().dimension())]) + "\n"); out.flush()
print("done")
