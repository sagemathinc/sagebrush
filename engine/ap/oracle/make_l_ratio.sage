import json
set_random_seed(7)
out = []
while len(out) < 60:
    a = [ZZ.random_element(-1,2), ZZ.random_element(-1,2), ZZ.random_element(-1,2), ZZ.random_element(-30,30), ZZ.random_element(-60,60)]
    try: E = EllipticCurve(a).minimal_model()
    except ArithmeticError: continue
    if E.conductor() > 3000: continue
    try:
        q = E.lseries().L_ratio()
    except Exception as e:
        continue
    out.append({"a": [int(c) for c in E.ainvs()], "N": int(E.conductor()), "L_ratio": str(q), "T": int(E.torsion_order()), "c": int(E.tamagawa_product())})
json.dump(out, open("lr.json", "w"))
print(len(out), sum(1 for d in out if d["L_ratio"] != "0"))
