"""The spring layout of web/graph/spring.ts, in Python: the same positions to
the last bit for the same nodes, edges and seed (web/graph/test-spring.mjs
compares them), so that a graph's picture made here (Graph.plot, in the
browser's worker or the CPython package) and the canvas that animates it
there end in the same place.

    spring_layout(nodes, edges, seed, iterations=None, gap=24, length=None)
        nodes: [(id, w, h, fixed)] with fixed None or (x, y), a top-left
        corner; edges: [(from, to)]; ids are strings.  Returns {id: (x, y)}
        top-left corners, or None past the caps (as springLayout's null).
        length: spring.ts's, the distance between linked boxes' edges the
        forces aim at; None for the mean box size plus gap.

Every operation follows spring.ts's in the same order: IEEE doubles, the same
square roots, the same mulberry32 (32-bit integer arithmetic masked to
match Math.imul and >>>), the same rounding to 1e-6.
"""

import math

MAX_NODES = 1500
MAX_EDGES = 20000
WORK = 3e8
MIN_ITERATIONS = 50
MAX_ITERATIONS = 1000
PART_COST = 64
DEFAULT_ITERATIONS = 300
FINAL_SWEEPS = 60
MARGIN = 1e-3
MIN_LENGTH = 1
MAX_LENGTH = 1e5
_M = 0xFFFFFFFF

# the final sweeps run by every layout so far (spring.ts's springWork.sweeps)
work = {"sweeps": 0}


def _imul(a, b):
    """Math.imul: the low 32 bits of a * b, as a signed int"""
    r = (a * b) & _M
    return r - 0x100000000 if r & 0x80000000 else r


def _u(x):
    return x & _M


def _rng(seed):
    """mulberry32, as spring.ts's rng"""
    state = [_u(int(seed))]

    def nxt():
        a = _u(state[0] + 0x6D2B79F5)
        state[0] = a
        t = a
        t = _imul(t ^ (_u(t) >> 15), t | 1)
        t ^= t + _imul(t ^ (_u(t) >> 7), t | 61)
        t = _u(t)
        return _u(t ^ (t >> 14)) / 4294967296
    return nxt


class _Body:
    __slots__ = ("id", "w", "h", "r", "x", "y", "fixed", "fx", "fy")


def _separate(B, gap):
    moved = False
    n = len(B)
    for i in range(n):
        a = B[i]
        for j in range(i + 1, n):
            b = B[j]
            if a.fixed and b.fixed:
                continue
            ox = (a.w + b.w) / 2 + gap - abs(a.x - b.x)
            oy = (a.h + b.h) / 2 + gap - abs(a.y - b.y)
            if ox <= 1e-9 or oy <= 1e-9:
                continue
            moved = True
            along_x = ox < oy or (ox == oy and i % 2 == 0)
            if along_x:
                before = a.x < b.x or (a.x == b.x and i < j)
            else:
                before = a.y < b.y or (a.y == b.y and i < j)
            sign = -1 if before else 1
            need = (ox if along_x else oy) + MARGIN
            sa = 0 if a.fixed else (1 if b.fixed else 0.5)
            sb = 1 - sa
            if along_x:
                a.x += sign * need * sa
                b.x -= sign * need * sb
            else:
                a.y += sign * need * sa
                b.y -= sign * need * sb
    return moved


class _Part:
    def __init__(self, bodies, links, iterations, gap, length):
        self.bodies = bodies
        self.links = links
        self.iterations = iterations
        self.done = 0
        size = 0.0
        for b in bodies:
            size += max(b.w, b.h)
        size = size / max(len(bodies), 1)
        self.L = float(length) if length is not None else max(40, size) + gap
        self.t0 = (self.L * math.sqrt(len(bodies))) / 4

    def step(self, gap):
        B, n, L = self.bodies, len(self.bodies), self.L
        t = self.t0 * (1 - self.done / max(self.iterations, 1)) + 1e-3
        dx = [0.0] * n
        dy = [0.0] * n
        for i in range(n):
            for j in range(i + 1, n):
                ex = B[i].x - B[j].x
                ey = B[i].y - B[j].y
                d = math.sqrt(ex * ex + ey * ey)
                if d < 1e-9:
                    ex = 1e-3 * (i - j)
                    ey = 1e-3
                    d = math.sqrt(ex * ex + ey * ey)
                eff = max(d - B[i].r - B[j].r, 0.1 * L)
                f = (L * L) / eff / d
                dx[i] += ex * f
                dy[i] += ey * f
                dx[j] -= ex * f
                dy[j] -= ey * f
        for a, b in self.links:
            ex = B[a].x - B[b].x
            ey = B[a].y - B[b].y
            d = math.sqrt(ex * ex + ey * ey)
            if d < 1e-9:
                continue
            eff = max(d - B[a].r - B[b].r, 0)
            f = (eff * eff) / L / d
            dx[a] -= ex * f
            dy[a] -= ey * f
            dx[b] += ex * f
            dy[b] += ey * f
        for i in range(n):
            if B[i].fixed:
                continue
            m = math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
            if m < 1e-12:
                continue
            s = min(m, t) / m
            B[i].x += dx[i] * s
            B[i].y += dy[i] * s
        _separate(B, gap)
        self.done += 1


def _round(v):
    # (as JS Math.round(v * 1e6) / 1e6 + 0: halves up, never -0)
    r = math.floor(v * 1e6 + 0.5) / 1e6
    return r + 0.0 if r != 0 else 0.0


def _plan(nodes, edges, seed, iterations, gap, length):
    if len(nodes) > MAX_NODES or len(edges) > MAX_EDGES:
        return None
    # (spring.ts's length: a number from MIN_LENGTH to MAX_LENGTH, else None)
    if length is not None and not (isinstance(length, (int, float)) and not isinstance(length, bool)
                                   and MIN_LENGTH <= length <= MAX_LENGTH):
        return None
    index = {}
    for i, nd in enumerate(nodes):
        index[nd[0]] = i
    up = list(range(len(nodes)))

    def find(i):
        while up[i] != i:
            up[i] = up[up[i]]
            i = up[i]
        return i
    links = []
    for f, t in edges:
        a, b = index.get(f), index.get(t)
        if a is None or b is None or a == b:
            continue
        links.append((a, b))
        ra, rb = find(a), find(b)
        if ra != rb:
            up[max(ra, rb)] = min(ra, rb)
    groups = {}
    order = []
    for i in range(len(nodes)):
        r = find(i)
        if r not in groups:
            groups[r] = []
            order.append(r)
        groups[r].append(i)
    n = len(nodes)
    budget = WORK - (FINAL_SWEEPS + 3) * n * n
    # (and each link's force per iteration, HARD-7C9-1)
    sq = sum(len(groups[r]) ** 2 + PART_COST for r in order if len(groups[r]) > 1) + len(links)
    if budget < MIN_ITERATIONS * sq:
        return None
    want = DEFAULT_ITERATIONS if iterations is None else iterations
    asked = min(max(math.floor(want), 1), MAX_ITERATIONS)
    iters = max(MIN_ITERATIONS, min(asked, math.floor(budget / max(sq, 1))))
    random = _rng(seed)
    all_ = []
    for nid, w, h, fixed in nodes:
        b = _Body()
        b.id, b.w, b.h = nid, max(0, w), max(0, h)
        b.r = math.sqrt(b.w * b.w + b.h * b.h) / 2
        b.x = fixed[0] + b.w / 2 if fixed else 0
        b.y = fixed[1] + b.h / 2 if fixed else 0
        b.fixed = bool(fixed)
        b.fx = fixed[0] if fixed else 0
        b.fy = fixed[1] if fixed else 0
        all_.append(b)
    where = {}
    for r in order:
        for k, i in enumerate(groups[r]):
            where[i] = k
    part_links = {}
    for a, b in links:
        part_links.setdefault(find(a), []).append((where[a], where[b]))
    parts = []
    for r in order:
        part = _Part([all_[i] for i in groups[r]], part_links.get(r, []), iters if len(groups[r]) > 1 else 0, gap, length)
        side = part.L * math.sqrt(len(groups[r]))
        for b in part.bodies:
            if not b.fixed:
                b.x = random() * side
                b.y = random() * side
        parts.append(part)
    # (what the iterations leave, less the shelf and the check: the final
    # sweeps are counted against it, spring.ts's p.left, HARD-2F4-1)
    used = sum(pt.iterations * (len(pt.bodies) * len(pt.bodies) + PART_COST + len(pt.links)) for pt in parts)
    return parts, all_, gap, WORK - used - 2 * n * n


def _finish(parts, all_, gap, work_left):
    def sweeps(bs):
        nonlocal work_left
        cost = len(bs) * (len(bs) - 1) / 2
        for _ in range(FINAL_SWEEPS):
            if cost > work_left:
                break
            work_left -= cost
            work["sweeps"] += 1
            if not _separate(bs, gap):
                break

    def box(bs):
        x0 = y0 = math.inf
        x1 = y1 = -math.inf
        for b in bs:
            x0 = min(x0, b.x - b.w / 2)
            y0 = min(y0, b.y - b.h / 2)
            x1 = max(x1, b.x + b.w / 2)
            y1 = max(y1, b.y + b.h / 2)
        return x0, y0, x1, y1
    for part in parts:
        sweeps(part.bodies)
    pinned = [pt for pt in parts if any(b.fixed for b in pt.bodies)]
    free = [(pt, i, box(pt.bodies)) for i, pt in enumerate(pt for pt in parts if not any(b.fixed for b in pt.bodies))]
    free.sort(key=lambda f: (-len(f[0].bodies), f[1]))
    pin = box([b for pt in pinned for b in pt.bodies]) if pinned else None
    total = 0.0
    for _, _, bb in free:
        total += (bb[2] - bb[0] + gap) * (bb[3] - bb[1] + gap)
    width = max([math.sqrt(total) * 1.2] + [bb[2] - bb[0] for _, _, bb in free] + [0])
    x = 0
    y = pin[3] + gap * 2 if pin else 0
    row_h = 0
    left = pin[0] if pin else 0
    for pt, _, bb in free:
        w, h = bb[2] - bb[0], bb[3] - bb[1]
        if x > 0 and x + w > width:
            x = 0
            y += row_h + gap * 2
            row_h = 0
        ox, oy = left + x - bb[0], y - bb[1]
        for b in pt.bodies:
            b.x += ox
            b.y += oy
        x += w + gap * 2
        row_h = max(row_h, h)
    sweeps(all_)
    _shelve(all_, gap)


def _shelve(all_, gap):
    """the movable boxes still closer than gap to another, in a row below
    every other box, gap apart (spring.ts's shelve)"""
    bad = set()
    n = len(all_)
    for i in range(n):
        a = all_[i]
        for j in range(i + 1, n):
            b = all_[j]
            if a.fixed and b.fixed:
                continue
            ox = (a.w + b.w) / 2 + gap - abs(a.x - b.x)
            oy = (a.h + b.h) / 2 + gap - abs(a.y - b.y)
            if ox > -MARGIN / 2 and oy > -MARGIN / 2:
                bad.add(j if a.fixed else i)
    if not bad:
        return
    left, bottom = math.inf, -math.inf
    for i in range(n):
        if i in bad:
            continue
        left = min(left, all_[i].x - all_[i].w / 2)
        bottom = max(bottom, all_[i].y + all_[i].h / 2)
    if left == math.inf:
        left, bottom = 0, -gap
    x = left
    y = bottom + gap + MARGIN
    for i in range(n):
        if i not in bad:
            continue
        b = all_[i]
        b.x = x + b.w / 2
        b.y = y + b.h / 2
        x += b.w + gap + MARGIN


def gap_violations(nodes, pos, gap):
    """the pairs (by index) of boxes in pos closer than gap, two fixed ones
    aside (spring.ts's gapViolations)"""
    out = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            a, b = nodes[i], nodes[j]
            if a[3] and b[3]:
                continue
            p, q = pos[a[0]], pos[b[0]]
            aw, ah, bw, bh = max(0, a[1]), max(0, a[2]), max(0, b[1]), max(0, b[2])
            if p[0] < q[0] + bw + gap and q[0] < p[0] + aw + gap and p[1] < q[1] + bh + gap and q[1] < p[1] + ah + gap:
                out.append((i, j))
    return out


def spring_layout(nodes, edges, seed, iterations=None, gap=24, length=None):
    p = _plan(nodes, edges, seed, iterations, gap, length)
    if p is None:
        return None
    parts, all_, gap, work_left = p
    for part in parts:
        while part.done < part.iterations:
            part.step(gap)
    _finish(parts, all_, gap, work_left)
    # (a fixed box exactly where it was given; the promise checked on what
    # is returned: None rather than two boxes closer than gap)
    pos = {b.id: (b.fx, b.fy) if b.fixed else (_round(b.x - b.w / 2), _round(b.y - b.h / 2)) for b in all_}
    return pos if not gap_violations(nodes, pos, gap) else None
