"""scipy.integrate for Sagebrush: ordinary differential equations (odeint,
solve_ivp with RK45, RK23 and DOP853), integrals of functions (quad, dblquad,
nquad, tplquad) and of samples (trapezoid, cumulative_trapezoid, simpson).

Where things come from:
- solve_ivp and its explicit Runge-Kutta solvers follow SciPy's
  scipy/integrate/_ivp (BSD 3-Clause, see NOTICE.md): the same step-size
  control, initial step, error norms and dense output, so the steps taken
  agree with SciPy's to rounding error.  The methods are Dormand and Prince
  (1980) with Shampine's (1986) interpolant, Bogacki and Shampine (1989), and
  Hairer's DOP853 (Hairer, Norsett and Wanner, "Solving Ordinary Differential
  Equations I", 2nd ed., II.10), whose coefficients are SciPy's table.
- odeint integrates with Dormand and Prince's 5(4) pair and its interpolant
  under odeint's interface (LSODA's error test, rtol*|y| + atol, and its
  defaults).  (DOP853 takes fewer steps, but its interpolant between long
  steps is less accurate than LSODA's results at odeint's tolerances; the
  5(4) pair's is more accurate than LSODA on every problem we tried.)  It is not LSODA: its results agree with
  SciPy's within the tolerances, not bit for bit, and it has no stiff method,
  so a stiff problem stops with an error after mxstep steps instead of
  switching to BDF.
- quad is QUADPACK's QAGS and QAGI (Piessens, de Doncker-Kapenga, Uberhuber and
  Kahaner, 1983; public domain): 21- and 15-point Gauss-Kronrod rules, the
  epsilon algorithm, and QUADPACK's error estimates, as in SciPy.
- simpson and the trapezoid rules follow SciPy's formulas.

Options that are not implemented raise NotImplementedError; none is ignored.
(Under CPython, use SciPy itself.)"""
import math
import warnings
from bisect import bisect_left, bisect_right

import numpy as np

__all__ = ["odeint", "ODEintWarning", "solve_ivp", "OdeSolution", "OdeSolver", "DenseOutput",
           "RK23", "RK45", "DOP853", "quad", "dblquad", "tplquad", "nquad", "IntegrationWarning",
           "trapezoid", "cumulative_trapezoid", "simpson"]

_EPS = 2.220446049250313e-16
_TINY = 2.2250738585072014e-308
_HUGE = 1.7976931348623157e+308


class IntegrationWarning(UserWarning):
    """A warning from quad: the requested accuracy may not have been reached."""


class ODEintWarning(Warning):
    """odeint's message, with printmessg=True."""


def _unsupported(fn, what, why=""):
    raise NotImplementedError("%s: %s is not implemented in Sagebrush%s" % (fn, what, why and "; " + why))


# ---------------------------------------------------------------- Butcher tableaus
# A[s] is the list of (k, a_sk) with a_sk != 0, so a stage adds only its terms.

def _rows(a):
    return [[(k, c) for k, c in enumerate(r) if c != 0] for r in a]


# Dormand and Prince (1980), with Shampine's (1986) interpolant P, as SciPy's RK45
_RK45 = dict(
    order=5, err_order=4, n_stages=6,
    C=[0.0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1.0],
    A=_rows([[], [1 / 5], [3 / 40, 9 / 40], [44 / 45, -56 / 15, 32 / 9],
             [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
             [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656]]),
    B=[35 / 384, 0.0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
    E=[-71 / 57600, 0.0, 71 / 16695, -71 / 1920, 17253 / 339200, -22 / 525, 1 / 40],
    P=[[1.0, -8048581381 / 2820520608, 8663915743 / 2820520608, -12715105075 / 11282082432],
       [0.0, 0.0, 0.0, 0.0],
       [0.0, 131558114200 / 32700410799, -68118460800 / 10900136933, 87487479700 / 32700410799],
       [0.0, -1754552775 / 470086768, 14199869525 / 1410260304, -10690763975 / 1880347072],
       [0.0, 127303824393 / 49829197408, -318862633887 / 49829197408, 701980252875 / 199316789632],
       [0.0, -282668133 / 205662961, 2019193451 / 616988883, -1453857185 / 822651844],
       [0.0, 40617522 / 29380423, -110615467 / 29380423, 69997945 / 29380423]],
)

# Bogacki and Shampine (1989), with the cubic Hermite interpolant
_RK23 = dict(
    order=3, err_order=2, n_stages=3,
    C=[0.0, 1 / 2, 3 / 4],
    A=_rows([[], [1 / 2], [0.0, 3 / 4]]),
    B=[2 / 9, 1 / 3, 4 / 9],
    E=[5 / 72, -1 / 12, -1 / 9, 1 / 8],
    P=[[1.0, -4 / 3, 5 / 9], [0.0, 1.0, -2 / 3], [0.0, 4 / 3, -8 / 9], [0.0, -1.0, 1.0]],
)


def _dop853_table():
    """DOP853's coefficients (Hairer's, as tabulated in SciPy's
    integrate/_ivp/dop853_coefficients.py): 12 stages, 3 more for the
    7th-degree interpolant."""
    C = [0.0, 0.526001519587677318785587544488e-01, 0.789002279381515978178381316732e-01,
         0.118350341907227396726757197510, 0.281649658092772603273242802490,
         0.333333333333333333333333333333, 0.25, 0.307692307692307692307692307692,
         0.651282051282051282051282051282, 0.6, 0.857142857142857142857142857142, 1.0, 1.0,
         0.1, 0.2, 0.777777777777777777777777777778]
    A = [[0.0] * 16 for _ in range(16)]
    for (i, j), v in {
        (1, 0): 5.26001519587677318785587544488e-2, (2, 0): 1.97250569845378994544595329183e-2,
        (2, 1): 5.91751709536136983633785987549e-2, (3, 0): 2.95875854768068491816892993775e-2,
        (3, 2): 8.87627564304205475450678981324e-2, (4, 0): 2.41365134159266685502369798665e-1,
        (4, 2): -8.84549479328286085344864962717e-1, (4, 3): 9.24834003261792003115737966543e-1,
        (5, 0): 3.7037037037037037037037037037e-2, (5, 3): 1.70828608729473871279604482173e-1,
        (5, 4): 1.25467687566822425016691814123e-1, (6, 0): 3.7109375e-2,
        (6, 3): 1.70252211019544039314978060272e-1, (6, 4): 6.02165389804559606850219397283e-2,
        (6, 5): -1.7578125e-2, (7, 0): 3.70920001185047927108779319836e-2,
        (7, 3): 1.70383925712239993810214054705e-1, (7, 4): 1.07262030446373284651809199168e-1,
        (7, 5): -1.53194377486244017527936158236e-2, (7, 6): 8.27378916381402288758473766002e-3,
        (8, 0): 6.24110958716075717114429577812e-1, (8, 3): -3.36089262944694129406857109825,
        (8, 4): -8.68219346841726006818189891453e-1, (8, 5): 2.75920996994467083049415600797e1,
        (8, 6): 2.01540675504778934086186788979e1, (8, 7): -4.34898841810699588477366255144e1,
        (9, 0): 4.77662536438264365890433908527e-1, (9, 3): -2.48811461997166764192642586468,
        (9, 4): -5.90290826836842996371446475743e-1, (9, 5): 2.12300514481811942347288949897e1,
        (9, 6): 1.52792336328824235832596922938e1, (9, 7): -3.32882109689848629194453265587e1,
        (9, 8): -2.03312017085086261358222928593e-2, (10, 0): -9.3714243008598732571704021658e-1,
        (10, 3): 5.18637242884406370830023853209, (10, 4): 1.09143734899672957818500254654,
        (10, 5): -8.14978701074692612513997267357, (10, 6): -1.85200656599969598641566180701e1,
        (10, 7): 2.27394870993505042818970056734e1, (10, 8): 2.49360555267965238987089396762,
        (10, 9): -3.0467644718982195003823669022, (11, 0): 2.27331014751653820792359768449,
        (11, 3): -1.05344954667372501984066689879e1, (11, 4): -2.00087205822486249909675718444,
        (11, 5): -1.79589318631187989172765950534e1, (11, 6): 2.79488845294199600508499808837e1,
        (11, 7): -2.85899827713502369474065508674, (11, 8): -8.87285693353062954433549289258,
        (11, 9): 1.23605671757943030647266201528e1, (11, 10): 6.43392746015763530355970484046e-1,
        (12, 0): 5.42937341165687622380535766363e-2, (12, 5): 4.45031289275240888144113950566,
        (12, 6): 1.89151789931450038304281599044, (12, 7): -5.8012039600105847814672114227,
        (12, 8): 3.1116436695781989440891606237e-1, (12, 9): -1.52160949662516078556178806805e-1,
        (12, 10): 2.01365400804030348374776537501e-1, (12, 11): 4.47106157277725905176885569043e-2,
        (13, 0): 5.61675022830479523392909219681e-2, (13, 6): 2.53500210216624811088794765333e-1,
        (13, 7): -2.46239037470802489917441475441e-1, (13, 8): -1.24191423263816360469010140626e-1,
        (13, 9): 1.5329179827876569731206322685e-1, (13, 10): 8.20105229563468988491666602057e-3,
        (13, 11): 7.56789766054569976138603589584e-3, (13, 12): -8.298e-3,
        (14, 0): 3.18346481635021405060768473261e-2, (14, 5): 2.83009096723667755288322961402e-2,
        (14, 6): 5.35419883074385676223797384372e-2, (14, 7): -5.49237485713909884646569340306e-2,
        (14, 10): -1.08347328697249322858509316994e-4, (14, 11): 3.82571090835658412954920192323e-4,
        (14, 12): -3.40465008687404560802977114492e-4, (14, 13): 1.41312443674632500278074618366e-1,
        (15, 0): -4.28896301583791923408573538692e-1, (15, 5): -4.69762141536116384314449447206,
        (15, 6): 7.68342119606259904184240953878, (15, 7): 4.06898981839711007970213554331,
        (15, 8): 3.56727187455281109270669543021e-1, (15, 12): -1.39902416515901462129418009734e-3,
        (15, 13): 2.9475147891527723389556272149, (15, 14): -9.15095847217987001081870187138,
    }.items():
        A[i][j] = v
    B = A[12][:12]
    E3 = list(B) + [0.0]
    E3[0] -= 0.244094488188976377952755905512
    E3[8] -= 0.733846688281611857341361741547
    E3[11] -= 0.220588235294117647058823529412e-1
    E5 = [0.0] * 13
    for k, v in {0: 0.1312004499419488073250102996e-1, 5: -0.1225156446376204440720569753e+1,
                 6: -0.4957589496572501915214079952, 7: 0.1664377182454986536961530415e+1,
                 8: -0.3503288487499736816886487290, 9: 0.3341791187130174790297318841,
                 10: 0.8192320648511571246570742613e-1, 11: -0.2235530786388629525884427845e-1}.items():
        E5[k] = v
    D = [[0.0] * 16 for _ in range(4)]
    for (i, j), v in {
        (0, 0): -0.84289382761090128651353491142e+1, (0, 5): 0.56671495351937776962531783590,
        (0, 6): -0.30689499459498916912797304727e+1, (0, 7): 0.23846676565120698287728149680e+1,
        (0, 8): 0.21170345824450282767155149946e+1, (0, 9): -0.87139158377797299206789907490,
        (0, 10): 0.22404374302607882758541771650e+1, (0, 11): 0.63157877876946881815570249290,
        (0, 12): -0.88990336451333310820698117400e-1, (0, 13): 0.18148505520854727256656404962e+2,
        (0, 14): -0.91946323924783554000451984436e+1, (0, 15): -0.44360363875948939664310572000e+1,
        (1, 0): 0.10427508642579134603413151009e+2, (1, 5): 0.24228349177525818288430175319e+3,
        (1, 6): 0.16520045171727028198505394887e+3, (1, 7): -0.37454675472269020279518312152e+3,
        (1, 8): -0.22113666853125306036270938578e+2, (1, 9): 0.77334326684722638389603898808e+1,
        (1, 10): -0.30674084731089398182061213626e+2, (1, 11): -0.93321305264302278729567221706e+1,
        (1, 12): 0.15697238121770843886131091075e+2, (1, 13): -0.31139403219565177677282850411e+2,
        (1, 14): -0.93529243588444783865713862664e+1, (1, 15): 0.35816841486394083752465898540e+2,
        (2, 0): 0.19985053242002433820987653617e+2, (2, 5): -0.38703730874935176555105901742e+3,
        (2, 6): -0.18917813819516756882830838328e+3, (2, 7): 0.52780815920542364900561016686e+3,
        (2, 8): -0.11573902539959630126141871134e+2, (2, 9): 0.68812326946963000169666922661e+1,
        (2, 10): -0.10006050966910838403183860980e+1, (2, 11): 0.77771377980534432092869265740,
        (2, 12): -0.27782057523535084065932004339e+1, (2, 13): -0.60196695231264120758267380846e+2,
        (2, 14): 0.84320405506677161018159903784e+2, (2, 15): 0.11992291136182789328035130030e+2,
        (3, 0): -0.25693933462703749003312586129e+2, (3, 5): -0.15418974869023643374053993627e+3,
        (3, 6): -0.23152937917604549567536039109e+3, (3, 7): 0.35763911791061412378285349910e+3,
        (3, 8): 0.93405324183624310003907691704e+2, (3, 9): -0.37458323136451633156875139351e+2,
        (3, 10): 0.10409964950896230045147246184e+3, (3, 11): 0.29840293426660503123344363579e+2,
        (3, 12): -0.43533456590011143754432175058e+2, (3, 13): 0.96324553959188282948394950600e+2,
        (3, 14): -0.39177261675615439165231486172e+2, (3, 15): -0.14972683625798562581422125276e+3,
    }.items():
        D[i][j] = v
    return dict(order=8, err_order=7, n_stages=12, C=C[:12], A=_rows([r[:12] for r in A[:12]]),
                B=B, E3=E3, E5=E5, D=D, C_EXTRA=C[13:], A_EXTRA=_rows(A[13:]))


_DOP853 = _dop853_table()

_SAFETY = 0.9
_MIN_FACTOR = 0.2
_MAX_FACTOR = 10.0


# ---------------------------------------------------------------- the solvers' arithmetic, on lists

def _rk_step(fun, t, y, f, h, tab, K):
    """One explicit Runge-Kutta step: K[0..s] are the stages (K[s] = f(t+h, y_new))."""
    n = len(y)
    K[0] = f
    C, A = tab["C"], tab["A"]
    for s in range(1, len(C)):
        terms = A[s]
        yi = [0.0] * n
        for j in range(n):
            acc = 0.0
            for k, a in terms:
                acc += K[k][j] * a
            yi[j] = y[j] + acc * h
        K[s] = fun(t + C[s] * h, yi)
    B = tab["B"]
    y_new = [0.0] * n
    for j in range(n):
        acc = 0.0
        for k in range(len(B)):
            acc += K[k][j] * B[k]
        y_new[j] = y[j] + h * acc
    f_new = fun(t + h, y_new)
    K[len(C)] = f_new
    return y_new, f_new


def _comb(K, coefs, j):
    acc = 0.0
    for k in range(len(coefs)):
        c = coefs[k]
        if c != 0.0:
            acc += K[k][j] * c
    return acc


def _error_norm(tab, K, h, scale):
    n = len(scale)
    if n == 0:
        return 0.0
    if "E5" in tab:   # DOP853: the 5th- and 3rd-order estimates combined (Hairer)
        e5 = e3 = 0.0
        for j in range(n):
            a = abs(_comb(K, tab["E5"], j) / scale[j])
            b = abs(_comb(K, tab["E3"], j) / scale[j])
            e5 += a * a
            e3 += b * b
        if e5 == 0 and e3 == 0:
            return 0.0
        return abs(h) * e5 / math.sqrt((e5 + 0.01 * e3) * n)
    E = tab["E"]
    s = 0.0
    for j in range(n):
        e = abs(_comb(K, E, j) * h / scale[j])
        s += e * e
    return math.sqrt(s / n)


def _rms(v):
    if not v:
        return 0.0
    s = 0.0
    for x in v:
        a = abs(x)
        s += a * a
    return math.sqrt(s / len(v))


def _initial_step(fun, t0, y0, f0, direction, order, rtol, atol, interval_length, max_step):
    """Hairer, Norsett and Wanner's starting step (as SciPy's select_initial_step)."""
    if not y0:
        return math.inf
    if interval_length == 0.0:
        return 0.0
    scale = [atol[j] + abs(y0[j]) * rtol[j] for j in range(len(y0))]
    d0 = _rms([y0[j] / scale[j] for j in range(len(y0))])
    d1 = _rms([f0[j] / scale[j] for j in range(len(y0))])
    h0 = 1e-6 if d0 < 1e-5 or d1 < 1e-5 else 0.01 * d0 / d1
    h0 = min(h0, interval_length)
    y1 = [y0[j] + h0 * direction * f0[j] for j in range(len(y0))]
    f1 = fun(t0 + h0 * direction, y1)
    d2 = _rms([(f1[j] - f0[j]) / scale[j] for j in range(len(y0))]) / h0
    if d1 <= 1e-15 and d2 <= 1e-15:
        h1 = max(1e-6, h0 * 1e-3)
    else:
        h1 = (0.01 / max(d1, d2)) ** (1 / (order + 1))
    return min(100 * h0, h1, interval_length, max_step)


class _RkInterp:
    """y(t_old + x h) = y_old + h Q [x, x^2, ...] (RK45, RK23)."""

    def __init__(self, t_old, t, y_old, Q):
        self.t_old, self.t, self.h, self.y_old, self.Q = t_old, t, t - t_old, y_old, Q

    def at(self, t):
        x = (t - self.t_old) / self.h
        h = self.h
        out = []
        for j, row in enumerate(self.Q):
            p = x
            acc = 0.0
            for q in row:
                acc += q * p
                p *= x
            out.append(self.y_old[j] + h * acc)
        return out


class _Dop853Interp:
    def __init__(self, t_old, t, y_old, F):
        self.t_old, self.t, self.h, self.y_old, self.F = t_old, t, t - t_old, y_old, F

    def at(self, t):
        x = (t - self.t_old) / self.h
        n = len(self.y_old)
        y = [0.0] * n
        for i, f in enumerate(reversed(self.F)):
            m = x if i % 2 == 0 else 1 - x
            for j in range(n):
                y[j] = (y[j] + f[j]) * m
        return [y[j] + self.y_old[j] for j in range(n)]


class _ConstInterp:
    def __init__(self, t_old, t, y):
        self.t_old, self.t, self.y_old = t_old, t, y

    def at(self, t):
        return list(self.y_old)


def _interpolant(tab, fun, t_old, t, y_old, y, f, h, K):
    """The dense output of the step from (t_old, y_old) to (t, y), whose stages are K."""
    n = len(y)
    if "D" not in tab:
        P = tab["P"]
        Q = [[_comb(K, [P[k][c] for k in range(len(P))], j) for c in range(len(P[0]))] for j in range(n)]
        return _RkInterp(t_old, t, y_old, Q)
    ns = tab["n_stages"]
    for s, c in enumerate(tab["C_EXTRA"]):
        idx = ns + 1 + s
        terms = tab["A_EXTRA"][s]
        yi = [y_old[j] + sum(K[k][j] * a for k, a in terms) * h for j in range(n)]
        K[idx] = fun(t_old + c * h, yi)
    f_old = K[0]
    F = [[0.0] * n for _ in range(7)]
    for j in range(n):
        dy = y[j] - y_old[j]
        F[0][j] = dy
        F[1][j] = h * f_old[j] - dy
        F[2][j] = 2 * dy - h * (f[j] + f_old[j])
    for i, drow in enumerate(tab["D"]):
        for j in range(n):
            F[3 + i][j] = h * _comb(K, drow, j)
    return _Dop853Interp(t_old, t, y_old, F)


def _wrap_fun(fun, n, is_complex, y_first, args, vectorized, who):
    """fun as a function of (t, list) returning a list; fun itself gets an ndarray."""
    conv = complex if is_complex else float
    dtype = complex if is_complex else float

    def g(t, y):
        ya = np.array(y, dtype=dtype)
        if vectorized:
            ya = ya.reshape(n, 1)
        r = fun(ya, t, *args) if y_first else fun(t, ya, *args)
        if not vectorized and type(r) is list and len(r) == n:
            try:
                return [conv(v) for v in r]
            except TypeError:
                pass
        a = np.asarray(r, dtype=dtype)
        if vectorized:
            a = a.ravel()
        if a.shape != (n,):
            raise ValueError("%s: the function returned an array of shape %s; it must have the shape of y0, (%d,)"
                             % (who, tuple(a.shape), n))
        return a.tolist()
    return g


# ---------------------------------------------------------------- solve_ivp's solver classes

class DenseOutput:
    """The solution between two steps, as a function of t (a float or 1-D array)."""

    def __init__(self, t_old, t, impl=None, is_complex=False):
        self.t_old = t_old
        self.t = t
        self.t_min = min(t, t_old)
        self.t_max = max(t, t_old)
        self._impl = impl
        self._dtype = complex if is_complex else float

    def __call__(self, t):
        t = np.asarray(t)
        if t.ndim > 1:
            raise ValueError("`t` must be a float or a 1-D array.")
        if t.ndim == 0:
            return np.array(self._impl.at(float(t)), dtype=self._dtype)
        cols = [self._impl.at(float(v)) for v in t.tolist()]
        n = len(self._impl.y_old)
        return np.array(cols, dtype=self._dtype).reshape(len(cols), n).T


class OdeSolver:
    """Base class of solve_ivp's solvers: step() advances one step."""
    TOO_SMALL_STEP = "Required step size is less than spacing between numbers."

    def __init__(self, fun, t0, y0, t_bound, vectorized, support_complex=False):
        self.t_old = None
        self.t = float(t0)
        y0 = np.asarray(y0)
        is_complex = y0.dtype.kind == "c"
        if is_complex and not support_complex:
            raise ValueError("`y0` is complex, but the chosen solver does not support integration in a complex domain.")
        if y0.ndim != 1:
            raise ValueError("`y0` must be 1-dimensional.")
        conv = complex if is_complex else float
        self._y = [conv(v) for v in y0.tolist()]
        if not all(math.isfinite(abs(v)) for v in self._y):
            raise ValueError("All components of the initial state `y0` must be finite.")
        self._complex = is_complex
        self.n = len(self._y)
        self.t_bound = float(t_bound)
        self.vectorized = vectorized
        g = _wrap_fun(fun, self.n, is_complex, False, (), vectorized, "solve_ivp")

        def counted(t, y):
            self.nfev += 1
            return g(t, y)
        self._fun = counted
        self.direction = (1.0 if t_bound > t0 else -1.0) if t_bound != t0 else 1.0
        self.status = "running"
        self.nfev = 0
        self.njev = 0
        self.nlu = 0

    @property
    def y(self):
        return np.array(self._y, dtype=complex if self._complex else float)

    def fun(self, t, y):
        return np.array(self._fun(float(t), np.asarray(y).tolist()), dtype=complex if self._complex else float)

    @property
    def step_size(self):
        return None if self.t_old is None else abs(self.t - self.t_old)

    def step(self):
        """One step; returns None, or a message if the solver failed."""
        if self.status != "running":
            raise RuntimeError("Attempt to step on a failed or finished solver.")
        if self.n == 0 or self.t == self.t_bound:
            self.t_old = self.t
            self.t = self.t_bound
            message = None
            self.status = "finished"
        else:
            t = self.t
            success, message = self._step_impl()
            if not success:
                self.status = "failed"
            else:
                self.t_old = t
                if self.direction * (self.t - self.t_bound) >= 0:
                    self.status = "finished"
        return message

    def dense_output(self):
        if self.t_old is None:
            raise RuntimeError("Dense output is available after a successful step was made.")
        return DenseOutput(self.t_old, self.t, self._interp(), self._complex)

    def _interp(self):
        if self.n == 0 or self.t == self.t_old:
            return _ConstInterp(self.t_old, self.t, self._y)
        return self._interp_impl()


class _RungeKutta(OdeSolver):
    _tab = None

    def __init__(self, fun, t0, y0, t_bound, max_step=math.inf, rtol=1e-3, atol=1e-6, vectorized=False,
                 first_step=None, **extraneous):
        if extraneous:
            warnings.warn("The following arguments have no effect for a chosen solver: %s."
                          % ", ".join("`%s`" % x for x in extraneous), stacklevel=3)
        super().__init__(fun, t0, y0, t_bound, vectorized, support_complex=True)
        self.y_old = None
        if max_step <= 0:
            raise ValueError("`max_step` must be positive.")
        self.max_step = float(max_step)
        self._rtol, self._atol = _tolerances(rtol, atol, self.n)
        self._f = self._fun(self.t, self._y)
        tab = self._tab
        if first_step is None:
            self.h_abs = _initial_step(self._fun, self.t, self._y, self._f, self.direction, tab["err_order"],
                                       self._rtol, self._atol, abs(self.t_bound - self.t), self.max_step)
        else:
            if first_step <= 0:
                raise ValueError("`first_step` must be positive.")
            if first_step > abs(t_bound - t0):
                raise ValueError("`first_step` exceeds bounds.")
            self.h_abs = float(first_step)
        self._K = [None] * (len(tab["C"]) + 1 + len(tab.get("C_EXTRA", ())))
        self._error_exponent = -1 / (tab["err_order"] + 1)
        self.h_previous = None
        self._y_old = None

    def _step_impl(self):
        t, y, tab = self.t, self._y, self._tab
        rtol, atol = self._rtol, self._atol
        min_step = 10 * abs(math.nextafter(t, self.direction * math.inf) - t)
        if self.h_abs > self.max_step:
            h_abs = self.max_step
        elif self.h_abs < min_step:
            h_abs = min_step
        else:
            h_abs = self.h_abs
        accepted = rejected = False
        while not accepted:
            if h_abs < min_step:
                return False, self.TOO_SMALL_STEP
            h = h_abs * self.direction
            t_new = t + h
            if self.direction * (t_new - self.t_bound) > 0:
                t_new = self.t_bound
            h = t_new - t
            h_abs = abs(h)
            y_new, f_new = _rk_step(self._fun, t, y, self._f, h, tab, self._K)
            scale = [atol[j] + max(abs(y[j]), abs(y_new[j])) * rtol[j] for j in range(self.n)]
            err = _error_norm(tab, self._K, h, scale)
            if err < 1:
                factor = _MAX_FACTOR if err == 0 else min(_MAX_FACTOR, _SAFETY * err ** self._error_exponent)
                if rejected:
                    factor = min(1, factor)
                h_abs *= factor
                accepted = True
            else:
                h_abs *= max(_MIN_FACTOR, _SAFETY * err ** self._error_exponent)
                rejected = True
        self.h_previous = h
        self._y_old = y
        self.t = t_new
        self._y = y_new
        self.h_abs = h_abs
        self._f = f_new
        return True, None

    @property
    def y_old(self):
        return None if self._y_old is None else np.array(self._y_old, dtype=complex if self._complex else float)

    @y_old.setter
    def y_old(self, v):
        self._y_old = v

    def _interp_impl(self):
        return _interpolant(self._tab, self._fun, self.t_old, self.t, self._y_old, self._y, self._f,
                            self.h_previous, self._K)


class RK45(_RungeKutta):
    """Explicit Runge-Kutta method of order 5(4) (Dormand and Prince), with a
    4th-order interpolant; solve_ivp's default."""
    _tab = _RK45
    order = 5
    error_estimator_order = 4
    n_stages = 6


class RK23(_RungeKutta):
    """Explicit Runge-Kutta method of order 3(2) (Bogacki and Shampine), with
    cubic Hermite interpolation."""
    _tab = _RK23
    order = 3
    error_estimator_order = 2
    n_stages = 3


class DOP853(_RungeKutta):
    """Explicit Runge-Kutta method of order 8 (Hairer's DOP853), with a
    7th-order interpolant; for tight tolerances."""
    _tab = _DOP853
    order = 8
    error_estimator_order = 7
    n_stages = 12


def _tolerances(rtol, atol, n):
    """rtol and atol as lists of n floats (validated as SciPy's validate_tol)."""
    r = np.asarray(rtol, dtype=float)
    if r.ndim > 0 and r.shape != (n,):
        raise ValueError("`rtol` has wrong shape.")
    rl = [float(r)] * n if r.ndim == 0 else [float(v) for v in r.tolist()]
    if any(v < 100 * _EPS for v in rl):
        warnings.warn("At least one element of `rtol` is too small. Setting `rtol = np.maximum(rtol, %s)`."
                      % (100 * _EPS), stacklevel=4)
        rl = [max(v, 100 * _EPS) for v in rl]
    a = np.asarray(atol, dtype=float)
    if a.ndim > 0 and a.shape != (n,):
        raise ValueError("`atol` has wrong shape.")
    al = [float(a)] * n if a.ndim == 0 else [float(v) for v in a.tolist()]
    if any(v < 0 for v in al):
        raise ValueError("`atol` must be positive.")
    return rl, al


class OdeSolution:
    """The solution of solve_ivp(..., dense_output=True) on its whole interval:
    sol(t) for a float or a 1-D array of times."""

    def __init__(self, ts, interpolants, alt_segment=False):
        ts = [float(v) for v in np.asarray(ts).tolist()]
        d = [b - a for a, b in zip(ts, ts[1:])]
        if not ((len(ts) == 2 and ts[0] == ts[-1]) or all(x > 0 for x in d) or all(x < 0 for x in d)):
            raise ValueError("`ts` must be strictly increasing or decreasing.")
        self.n_segments = len(interpolants)
        if len(ts) != self.n_segments + 1:
            raise ValueError("Numbers of time stamps and interpolants don't match.")
        self.ts = np.array(ts)
        self.interpolants = interpolants
        if ts[-1] >= ts[0]:
            self.t_min, self.t_max, self.ascending = ts[0], ts[-1], True
            self._side = "right" if alt_segment else "left"
            self._sorted = ts
        else:
            self.t_min, self.t_max, self.ascending = ts[-1], ts[0], False
            self._side = "left" if alt_segment else "right"
            self._sorted = ts[::-1]

    def _segment(self, t):
        ind = (bisect_left if self._side == "left" else bisect_right)(self._sorted, t)
        seg = min(max(ind - 1, 0), self.n_segments - 1)
        return seg if self.ascending else self.n_segments - 1 - seg

    def __call__(self, t):
        t = np.asarray(t)
        if t.ndim == 0:
            return self.interpolants[self._segment(float(t))](float(t))
        if t.ndim > 1:
            raise ValueError("`t` must be a float or a 1-D array.")
        ip = self.interpolants
        cols = [ip[self._segment(v)]._impl.at(v) for v in [float(x) for x in t.tolist()]]
        dt = ip[0]._dtype if ip else float
        n = len(cols[0]) if cols else 0
        return np.array(cols, dtype=dt).reshape(len(cols), n).T


class OdeResult(dict):
    """solve_ivp's result: a dict whose keys are also attributes (t, y, sol,
    t_events, y_events, nfev, njev, nlu, status, message, success)."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as e:
            raise AttributeError(name) from e

    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __repr__(self):
        order = ["message", "success", "status"]

        def key(item):
            k = item[0].lower()
            return order.index(k) if k in order else len(order)
        items = sorted(self.items(), key=key)
        if not items:
            return "OdeResult()"
        m = max(len(k) for k, _ in items) + 1
        return "\n".join(k.rjust(m) + ": " + _indent(_rich(v, m + 2), m + 2) for k, v in items)

    def __dir__(self):
        return list(self.keys())


def _indent(s, n):
    return ("\n" + " " * n).join(s.split("\n"))


# SciPy's result printing: numpy's str with linewidth 76 - indent, edgeitems
# 2, threshold 12 and floats as format_float_scientific(precision=3,
# pad_left=2, unique=False); lists of arrays print their repr.

def _sci(x):
    x = float(x)
    if math.isnan(x):
        return "       nan"
    if math.isinf(x):
        return "       inf" if x > 0 else "      -inf"
    s = "%.3e" % x
    return s if s.startswith("-") else " " + s


def _rich(v, n):
    width = 76 - n
    if isinstance(v, np.ndarray):
        return _fmt_array(v, width, " ", " ")
    if isinstance(v, list) and v and all(isinstance(a, np.ndarray) for a in v):
        return "[" + ", ".join("array(" + _fmt_array(a, width, " " * 7, ", ") + ")" for a in v) + "]"
    return str(v)


def _fmt_array(a, width, prefix, sep):
    """numpy's _formatArray for float (or int) arrays, as SciPy prints results."""
    if a.dtype.kind in "iub":
        words = [str(x) for x in a.ravel().tolist()]
        fmt = None
    else:
        fmt = _sci
    summarize = a.size > 12
    shape = a.shape
    if len(shape) == 0:
        return fmt(a.item()) if fmt else str(a.item())
    flat = a.tolist()

    def item(x):
        return fmt(x) if fmt else str(x)
    if fmt is None:
        w = max((len(str(x)) for x in a.ravel().tolist()), default=0)

        def item(x):  # noqa: F811
            return str(x).rjust(w)

    def rec(sub, depth, hang, cw):
        if depth == len(shape):
            return item(sub)
        nhang = hang + " "
        nw = cw - 1
        L = len(sub)
        show = summarize and 4 < L
        lead, trail = (2, 2) if show else (0, L)
        if depth == len(shape) - 1:
            ew = cw - max(len(sep.rstrip()), 1)
            s = ""
            line = hang

            def ext(s, line, word):
                if len(line) + len(word) > ew and len(line) > len(hang):
                    s += line.rstrip() + "\n"
                    line = hang
                return s, line + word
            for i in range(lead):
                s, line = ext(s, line, rec(sub[i], depth + 1, nhang, nw))
                line += sep
            if show:
                s, line = ext(s, line, "...")
                line += sep
            for i in range(trail, 1, -1):
                s, line = ext(s, line, rec(sub[-i], depth + 1, nhang, nw))
                line += sep
            s, line = ext(s, line, rec(sub[-1], depth + 1, nhang, nw))
            s += line
        else:
            s = ""
            lsep = sep.rstrip() + "\n" * (len(shape) - depth - 1)
            for i in range(lead):
                s += hang + rec(sub[i], depth + 1, nhang, nw) + lsep
            if show:
                s += hang + "..." + lsep
            for i in range(trail, 1, -1):
                s += hang + rec(sub[-i], depth + 1, nhang, nw) + lsep
            s += hang + rec(sub[-1], depth + 1, nhang, nw)
        return "[" + s[len(hang):] + "]"
    if a.size == 0:
        return "[]"
    return rec(flat, 0, prefix, width)


# ---------------------------------------------------------------- solve_ivp

_METHODS = {"RK23": RK23, "RK45": RK45, "DOP853": DOP853}
_MESSAGES = {0: "The solver successfully reached the end of the integration interval.",
             1: "A termination event occurred."}


def _brentq(f, a, b, xtol, rtol, maxiter=100):
    """A root of f in [a, b], where f changes sign: Brent's method (Brent,
    "Algorithms for Minimization without Derivatives", 1973, ch. 4)."""
    fpre, fcur = f(a), f(b)
    if fpre * fcur > 0:
        raise ValueError("f(a) and f(b) must have different signs")
    if fpre == 0:
        return a
    if fcur == 0:
        return b
    xpre, xcur = a, b
    xblk = fblk = spre = scur = 0.0
    for _ in range(maxiter):
        if fpre != 0 and fcur != 0 and (fpre < 0) != (fcur < 0):
            xblk, fblk = xpre, fpre
            spre = scur = xcur - xpre
        if abs(fblk) < abs(fcur):
            xpre, xcur, xblk = xcur, xblk, xcur
            fpre, fcur, fblk = fcur, fblk, fcur
        delta = (xtol + rtol * abs(xcur)) / 2
        sbis = (xblk - xcur) / 2
        if fcur == 0 or abs(sbis) < delta:
            return xcur
        if abs(spre) > delta and abs(fcur) < abs(fpre):
            if xpre == xblk:
                stry = -fcur * (xcur - xpre) / (fcur - fpre)
            else:
                dpre = (fpre - fcur) / (xpre - xcur)
                dblk = (fblk - fcur) / (xblk - xcur)
                stry = -fcur * (fblk * dblk - fpre * dpre) / (dblk * dpre * (fblk - fpre))
            if 2 * abs(stry) < min(abs(spre), 3 * abs(sbis) - delta):
                spre, scur = scur, stry
            else:
                spre = scur = sbis
        else:
            spre = scur = sbis
        xpre, fpre = xcur, fcur
        xcur += scur if abs(scur) > delta else (delta if sbis > 0 else -delta)
        fcur = f(xcur)
    raise RuntimeError("solve_ivp: locating an event did not converge in %d iterations" % maxiter)


def solve_ivp(fun, t_span, y0, method="RK45", t_eval=None, dense_output=False, events=None,
              vectorized=False, args=None, **options):
    """Solve the initial value problem y' = fun(t, y), y(t0) = y0, for t in
    t_span = (t0, tf).

    method is "RK45" (the default), "RK23" or "DOP853" (or a solver class);
    the implicit methods "Radau", "BDF" and "LSODA" are not implemented.
    t_eval gives the times at which to store the solution (by default, the
    steps taken); dense_output=True adds sol, the solution as a function;
    events are functions event(t, y) whose zeros are located (attributes
    terminal and direction as in SciPy).  args are passed to fun and the
    events.  Options: rtol (1e-3), atol (1e-6), max_step, first_step.

    Returns an OdeResult with t, y (one row per component), sol, t_events,
    y_events, nfev, njev, nlu, status, message and success.

    >>> sol = solve_ivp(lambda t, y: -0.5 * y, [0, 10], [2.0, 4.0, 8.0])
    >>> sol.y[:, -1]
    """
    if isinstance(method, str):
        if method in ("Radau", "BDF", "LSODA"):
            _unsupported("solve_ivp", "method=%r (an implicit method for stiff problems)" % method,
                         "use RK45, RK23 or DOP853")
        if method not in _METHODS:
            raise ValueError("`method` must be one of %s or OdeSolver class." % {**_METHODS, "Radau": None, "BDF": None, "LSODA": None})
        method = _METHODS[method]
    elif not (isinstance(method, type) and issubclass(method, OdeSolver)):
        raise ValueError("`method` must be one of %s or OdeSolver class." % list(_METHODS))
    t0, tf = map(float, t_span)
    if args is not None:
        try:
            args = tuple(args)
        except TypeError as exp:
            raise TypeError("Supplied 'args' cannot be unpacked. Please supply `args` as a tuple (e.g. `args=(%s,)`)"
                            % (args,)) from exp
        user_fun = fun

        def fun(t, x):
            return user_fun(t, x, *args)
        if "jac" in options and callable(options["jac"]):
            jac = options["jac"]
            options["jac"] = lambda t, x: jac(t, x, *args)
    te = None
    if t_eval is not None:
        te = np.asarray(t_eval, dtype=float)
        if te.ndim != 1:
            raise ValueError("`t_eval` must be 1-dimensional.")
        te = [float(v) for v in te.tolist()]
        if any(v < min(t0, tf) or v > max(t0, tf) for v in te):
            raise ValueError("Values in `t_eval` are not within `t_span`.")
        d = [b - a for a, b in zip(te, te[1:])]
        if (tf > t0 and any(x <= 0 for x in d)) or (tf < t0 and any(x >= 0 for x in d)):
            raise ValueError("Values in `t_eval` are not properly sorted.")
        if tf > t0:
            te_i = 0
        else:
            te = te[::-1]
            te_i = len(te)
    solver = method(fun, t0, y0, tf, vectorized=vectorized, **options)
    y0l = list(solver._y)
    if te is None:
        ts, ys = [t0], [y0l]
    else:
        ts, ys = [], []
        ti = [t0]
    interpolants = []
    if events is not None:
        if callable(events):
            events = (events,)
        max_events, event_dir = [], []
        for ev in events:
            terminal = getattr(ev, "terminal", None)
            event_dir.append(getattr(ev, "direction", 0))
            if terminal is None or terminal == 0:
                max_events.append(math.inf)
            elif int(terminal) == terminal and terminal > 0:
                max_events.append(terminal)
            else:
                raise ValueError("The `terminal` attribute of each event must be a boolean or positive integer.")
        if args is not None:
            events = [(lambda t, x, ev=ev: ev(t, x, *args)) for ev in events]
        event_count = [0] * len(events)
        g = [float(ev(t0, solver.y)) for ev in events]
        t_events = [[] for _ in events]
        y_events = [[] for _ in events]
    else:
        t_events = y_events = None
    status = None
    message = None
    while status is None:
        message = solver.step()
        if solver.status == "finished":
            status = 0
        elif solver.status == "failed":
            status = -1
            break
        t_old, t = solver.t_old, solver.t
        y = solver._y
        sol = solver.dense_output() if dense_output else None
        if dense_output:
            interpolants.append(sol)
        if events is not None:
            ya = solver.y
            g_new = [float(ev(t, ya)) for ev in events]
            active = []
            for i in range(len(events)):
                up = g[i] <= 0 <= g_new[i]
                down = g[i] >= 0 >= g_new[i]
                d = event_dir[i]
                if (up and d > 0) or (down and d < 0) or ((up or down) and d == 0):
                    active.append(i)
            if active:
                if sol is None:
                    sol = solver.dense_output()
                for i in active:
                    event_count[i] += 1
                roots = [_brentq(lambda tt, ev=events[i]: ev(tt, sol(tt)), t_old, t, 4 * _EPS, 4 * _EPS)
                         for i in active]
                terminate = False
                if any(event_count[i] >= max_events[i] for i in active):
                    order = sorted(range(len(active)), key=lambda k: roots[k] if t > t_old else -roots[k])
                    active = [active[k] for k in order]
                    roots = [roots[k] for k in order]
                    stop = next(k for k, i in enumerate(active) if event_count[i] >= max_events[i])
                    active, roots = active[:stop + 1], roots[:stop + 1]
                    terminate = True
                for i, r in zip(active, roots):
                    t_events[i].append(r)
                    y_events[i].append(sol(r))
                if terminate:
                    status = 1
                    t = roots[-1]
                    y = sol(t).tolist()
            g = g_new
        if te is None:
            if not (len(ts) > 1 and ts[-1] == t and dense_output):
                ts.append(t)
                ys.append(list(y))
            elif interpolants:
                interpolants.pop()
        else:
            if solver.direction > 0:
                new_i = bisect_right(te, t)
                step_ts = te[te_i:new_i]
            else:
                new_i = bisect_left(te, t)
                step_ts = te[new_i:te_i][::-1]
            if step_ts:
                ip = sol._impl if sol is not None else solver._interp()
                for v in step_ts:
                    ts.append(v)
                    ys.append(ip.at(v))
                te_i = new_i
        if te is not None and dense_output:
            ti.append(t)
    message = _MESSAGES.get(status, message)
    dt = complex if solver._complex else float
    if t_events is not None:
        t_events = [np.array(x, dtype=float) for x in t_events]
        y_events = [np.array([v.tolist() for v in x], dtype=dt) if x else np.zeros((0,), dtype=dt) for x in y_events]
    t_arr = np.array(ts, dtype=float)
    y_arr = np.array(ys, dtype=dt).reshape(len(ys), solver.n).T if ys else np.zeros((solver.n, 0), dtype=dt)
    if te is not None and not ts:
        t_arr = np.array([], dtype=float)
    if dense_output:
        sol = OdeSolution(ts if te is None else ti, interpolants)
    else:
        sol = None
    return OdeResult(t=t_arr, y=y_arr, sol=sol, t_events=t_events, y_events=y_events, nfev=solver.nfev,
                     njev=solver.njev, nlu=solver.nlu, status=status, message=message, success=status >= 0)


# ---------------------------------------------------------------- odeint

def odeint(func, y0, t, args=(), Dfun=None, col_deriv=0, full_output=0, ml=None, mu=None, rtol=None, atol=None,
           tcrit=None, h0=0.0, hmax=0.0, hmin=0.0, ixpr=0, mxstep=0, mxhnil=0, mxordn=12, mxords=5,
           printmessg=0, tfirst=False):
    """Integrate the system dy/dt = func(y, t, *args) from y(t[0]) = y0, and
    return y at each time in t: an array of shape (len(t), len(y0)), whose
    first row is y0.  (With tfirst=True, func is func(t, y, *args).)

    rtol and atol (default 1.49012e-8 each) bound each step's local error by
    rtol*|y| + atol, as LSODA's do; atol may be a vector.  h0 is the first
    step, hmax and hmin bound the step size (0: no bound), mxstep (default 500)
    is the most steps between two output times, and tcrit lists times the
    integration must not step past.  full_output=True also returns an infodict
    with hu, tcur, nst, nfe, nje, nqu and message.

    Sagebrush's odeint is the Dormand-Prince 5(4) method (an explicit
    Runge-Kutta method), not LSODA: results agree with SciPy within the
    tolerances.  It has no stiff method, so Dfun, ml, mu, mxordn and mxords are
    not implemented, and a stiff problem stops with an error at mxstep.

    >>> t = np.linspace(0, 1, 3)
    >>> odeint(lambda y, t: -y, 1.0, t)[:, 0]
    """
    if Dfun is not None:
        _unsupported("odeint", "Dfun (a Jacobian for the stiff method)",
                     "Sagebrush's odeint has no stiff method; drop Dfun")
    if ml is not None or mu is not None:
        _unsupported("odeint", "ml and mu (a banded Jacobian for the stiff method)")
    if mxordn != 12 or mxords != 5:
        _unsupported("odeint", "mxordn and mxords (the orders of LSODA's methods)",
                     "Sagebrush's odeint is the Dormand-Prince 5(4) method, of fixed order")
    tt = np.asarray(t, dtype=float)
    if tt.ndim != 1:
        tt = tt.ravel()
    ts = [float(v) for v in tt.tolist()]
    if not ts:
        raise ValueError("odeint: t must contain at least one time")
    d = [b - a for a, b in zip(ts, ts[1:])]
    if not (all(x >= 0 for x in d) or all(x <= 0 for x in d)):
        raise ValueError("The values in t must be monotonically increasing or monotonically decreasing; "
                         "repeated values are allowed.")
    ya0 = np.asarray(y0)
    if ya0.dtype.kind == "c":
        raise TypeError("odeint: y0 is complex; odeint integrates real systems (use solve_ivp for complex ones)")
    y = [float(v) for v in np.asarray(ya0, dtype=float).ravel().tolist()]
    n = len(y)
    rdef = 1.49012e-8
    rt, at = [], []
    for name, v, out in (("rtol", rtol, rt), ("atol", atol, at)):
        a = np.asarray(rdef if v is None else v, dtype=float)
        if a.ndim > 0 and a.shape != (n,):
            raise ValueError("odeint: %s must be a number or have the length of y0 (%d)" % (name, n))
        out.extend([float(a)] * n if a.ndim == 0 else [float(x) for x in a.tolist()])
        if any(x < 0 for x in out):
            raise ValueError("odeint: %s must not be negative" % name)
    if mxstep < 0 or hmin < 0 or hmax < 0 or h0 < 0:
        raise ValueError("odeint: mxstep, h0, hmin and hmax must not be negative")
    mxstep = int(mxstep) or 500
    hmax = float(hmax) or math.inf
    hmin = float(hmin)
    fun = _wrap_fun(func, n, False, not tfirst, tuple(args) if isinstance(args, (tuple, list)) else (args,),
                    False, "odeint")
    nfe = [0]

    def F(tv, yv):
        nfe[0] += 1
        return fun(tv, yv)
    tab = _RK45
    out = [list(y)]
    m = len(ts)
    hu, tcur, nst_l, nfe_l = [], [], [], []
    t0 = ts[0]
    tend = ts[-1]
    direction = 1.0 if tend >= t0 else -1.0
    crit = []
    if tcrit is not None:
        crit = sorted(float(v) for v in np.asarray(tcrit, dtype=float).ravel().tolist())
        if direction < 0:
            crit = crit[::-1]
    tc = t0
    f = F(tc, y) if n and m > 1 and tend != t0 else None
    K = [None] * 16
    h_abs = None
    nst = 0
    last_h = 0.0
    error_exp = -1 / (tab["err_order"] + 1)
    if n == 0:
        m_rows = np.zeros((m, 0))
        return (m_rows, {"message": "Integration successful."}) if full_output else m_rows
    for i in range(1, m):
        ti = ts[i]
        steps = 0
        while direction * (ti - tc) > 0:
            if steps >= mxstep:
                raise RuntimeError(
                    "odeint: excess work done: more than mxstep=%d steps between t=%r and t=%r (reached t=%r). "
                    "The problem may be stiff, which Sagebrush's odeint (Dormand-Prince, an explicit method) cannot "
                    "integrate efficiently; increase mxstep or loosen rtol/atol." % (mxstep, ts[i - 1], ti, tc))
            bound = tend
            for c in crit:
                if direction * (c - tc) > 0:
                    bound = c if direction * (c - tend) < 0 else tend
                    break
            if h_abs is None:
                if not all(at[j] + abs(y[j]) * rt[j] for j in range(n)):
                    raise RuntimeError("odeint: the error weight rtol*|y| + atol is zero at t=%r; use atol > 0" % tc)
                h_abs = float(h0) if h0 else _initial_step(F, tc, y, f, direction, tab["err_order"], rt, at,
                                                           abs(tend - tc), hmax)
                h_abs = min(h_abs, hmax)
            min_step = 10 * abs(math.nextafter(tc, direction * math.inf) - tc)
            rejected = False
            while True:
                h_abs = min(h_abs, hmax)
                if h_abs < min_step:
                    raise RuntimeError("odeint: the step size became too small at t=%r (%r): the tolerances may be "
                                       "too small, or the solution singular" % (tc, h_abs))
                t_new = tc + direction * h_abs
                if direction * (t_new - bound) > 0:
                    t_new = bound
                h = t_new - tc
                if abs(h) < hmin and t_new != bound:
                    raise RuntimeError("odeint: the step size needed at t=%r is below hmin=%r" % (tc, hmin))
                y_new, f_new = _rk_step(F, tc, y, f, h, tab, K)
                scale = [at[j] + max(abs(y[j]), abs(y_new[j])) * rt[j] for j in range(n)]
                if not all(scale):
                    raise RuntimeError("odeint: the error weight rtol*|y| + atol became zero at t=%r (component %d); "
                                       "use atol > 0" % (tc, scale.index(0.0)))
                err = _error_norm(tab, K, h, scale)
                if err != err:
                    err = math.inf
                if err < 1:
                    factor = _MAX_FACTOR if err == 0 else min(_MAX_FACTOR, _SAFETY * err ** error_exp)
                    if rejected:
                        factor = min(1, factor)
                    h_abs = abs(h) * factor
                    break
                if abs(h) <= hmin:
                    raise RuntimeError("odeint: repeated error test failures at t=%r with the step size at hmin=%r"
                                       % (tc, hmin))
                h_abs = max(abs(h) * max(_MIN_FACTOR, _SAFETY * err ** error_exp), hmin)
                rejected = True
            t_old, y_old = tc, y
            tc, y, f = t_new, y_new, f_new
            nst += 1
            steps += 1
            last_h = h
            # each output time this step passed, from its interpolant
            if direction * (ti - tc) <= 0:
                ip = None
                k = i
                while k < m and direction * (ts[k] - tc) <= 0:
                    if ts[k] == tc:
                        out.append(list(y))
                    else:
                        if ip is None:
                            ip = _interpolant(tab, F, t_old, tc, y_old, y, f, h, K)
                        out.append(ip.at(ts[k]))
                    hu.append(abs(last_h))
                    tcur.append(tc)
                    nst_l.append(nst)
                    nfe_l.append(nfe[0])
                    k += 1
                break
        else:
            # ti was reached by an earlier step (or repeats the previous time)
            if len(out) <= i:
                if ti == tc:
                    out.append(list(y))
                else:   # ti == t0 at the start, or a repeated time
                    out.append(list(out[-1]))
                hu.append(abs(last_h))
                tcur.append(tc)
                nst_l.append(nst)
                nfe_l.append(nfe[0])
    result = np.array(out, dtype=float).reshape(m, n)
    message = "Integration successful."
    if printmessg:
        warnings.warn(message, ODEintWarning, stacklevel=2)
    if full_output:
        info = {"hu": np.array(hu[:m - 1], dtype=float), "tcur": np.array(tcur[:m - 1], dtype=float),
                "nst": np.array(nst_l[:m - 1], dtype=np.int32), "nfe": np.array(nfe_l[:m - 1], dtype=np.int32),
                "nje": np.zeros(m - 1, dtype=np.int32), "nqu": np.full(m - 1, 5, dtype=np.int32),
                "message": message}
        return result, info
    return result


# ---------------------------------------------------------------- quad (QUADPACK)

_XGK21 = [0.995657163025808080735527280689003, 0.973906528517171720077964012084452,
          0.930157491355708226001207180059508, 0.865063366688984510732096688423493,
          0.780817726586416897063717578345042, 0.679409568299024406234327365114874,
          0.562757134668604683339000099272694, 0.433395394129247190799265943165784,
          0.294392862701460198131126603103866, 0.148874338981631210884826001129720, 0.0]
_WGK21 = [0.011694638867371874278064396062192, 0.032558162307964727478818972459390,
          0.054755896574351996031381300244580, 0.075039674810919952767043140916190,
          0.093125454583697605535065465083366, 0.109387158802297641899210590325805,
          0.123491976262065851077208980457029, 0.134709217311473325928054001771707,
          0.142775938577060080797094273138717, 0.147739104901338491374841515972068,
          0.149445554002916905664936468389821]
_WG10 = [0.066671344308688137593568809893332, 0.149451349150580593145776339657697,
         0.219086362515982043995534934228163, 0.269266719309996355091226921569469,
         0.295524224714752870173892994651338]
_XGK15 = [0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
          0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
          0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
          0.207784955007898467600689403773245, 0.0]
_WGK15 = [0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
          0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
          0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
          0.204432940075298892414161999234649, 0.209482141084727828012999174891714]
_WG7 = [0.0, 0.129484966168869693270611432679082, 0.0, 0.279705391489276667901467771423780,
        0.0, 0.381830050505118944950369775488975, 0.0, 0.417959183673469387755102040816327]


def _qk_err(abserr, resabs, resasc):
    if resasc != 0 and abserr != 0:
        abserr = resasc * min(1.0, (200 * abserr / resasc) ** 1.5)
    if resabs > _TINY / (50 * _EPS):
        abserr = max(_EPS * 50 * resabs, abserr)
    return abserr


def _qk21(f, a, b):
    """QUADPACK's dqk21: (result, abserr, resabs, resasc)."""
    centr = 0.5 * (a + b)
    hlgth = 0.5 * (b - a)
    dhlgth = abs(hlgth)
    resg = 0.0
    fc = f(centr)
    resk = _WGK21[10] * fc
    resabs = abs(resk)
    fv1 = [0.0] * 10
    fv2 = [0.0] * 10
    for j in range(5):
        jtw = 2 * j + 1
        absc = hlgth * _XGK21[jtw]
        f1 = f(centr - absc)
        f2 = f(centr + absc)
        fv1[jtw], fv2[jtw] = f1, f2
        fsum = f1 + f2
        resg += _WG10[j] * fsum
        resk += _WGK21[jtw] * fsum
        resabs += _WGK21[jtw] * (abs(f1) + abs(f2))
    for j in range(5):
        jtwm1 = 2 * j
        absc = hlgth * _XGK21[jtwm1]
        f1 = f(centr - absc)
        f2 = f(centr + absc)
        fv1[jtwm1], fv2[jtwm1] = f1, f2
        fsum = f1 + f2
        resk += _WGK21[jtwm1] * fsum
        resabs += _WGK21[jtwm1] * (abs(f1) + abs(f2))
    reskh = resk * 0.5
    resasc = _WGK21[10] * abs(fc - reskh)
    for j in range(10):
        resasc += _WGK21[j] * (abs(fv1[j] - reskh) + abs(fv2[j] - reskh))
    result = resk * hlgth
    resabs *= dhlgth
    resasc *= dhlgth
    abserr = abs((resk - resg) * hlgth)
    return result, _qk_err(abserr, resabs, resasc), resabs, resasc


def _qk15i(f, boun, inf, a, b):
    """QUADPACK's dqk15i: the 15-point rule on (a, b) within (0, 1), after
    x = boun + dinf (1 - t)/t."""
    dinf = min(1, inf)
    centr = 0.5 * (a + b)
    hlgth = 0.5 * (b - a)
    tabsc1 = boun + dinf * (1 - centr) / centr
    fval1 = f(tabsc1)
    if inf == 2:
        fval1 += f(-tabsc1)
    fc = (fval1 / centr) / centr
    resg = _WG7[7] * fc
    resk = _WGK15[7] * fc
    resabs = abs(resk)
    fv1 = [0.0] * 7
    fv2 = [0.0] * 7
    for j in range(7):
        absc = hlgth * _XGK15[j]
        absc1 = centr - absc
        absc2 = centr + absc
        t1 = boun + dinf * (1 - absc1) / absc1
        t2 = boun + dinf * (1 - absc2) / absc2
        f1 = f(t1)
        f2 = f(t2)
        if inf == 2:
            f1 += f(-t1)
            f2 += f(-t2)
        f1 = (f1 / absc1) / absc1
        f2 = (f2 / absc2) / absc2
        fv1[j], fv2[j] = f1, f2
        fsum = f1 + f2
        resg += _WG7[j] * fsum
        resk += _WGK15[j] * fsum
        resabs += _WGK15[j] * (abs(f1) + abs(f2))
    reskh = resk * 0.5
    resasc = _WGK15[7] * abs(fc - reskh)
    for j in range(7):
        resasc += _WGK15[j] * (abs(fv1[j] - reskh) + abs(fv2[j] - reskh))
    result = resk * hlgth
    resasc *= hlgth
    resabs *= hlgth
    abserr = abs((resk - resg) * hlgth)
    return result, _qk_err(abserr, resabs, resasc), resabs, resasc


def _qpsrt(limit, last, maxerr, elist, iord, nrmax):
    """QUADPACK's dqpsrt: keep iord (1-based indices into elist) in decreasing
    order of error; returns (maxerr, ermax, nrmax)."""
    if last <= 2:
        iord[1] = 1
        iord[2] = 2
    else:
        errmax = elist[maxerr]
        if nrmax != 1:
            for _ in range(nrmax - 1):
                isucc = iord[nrmax - 1]
                if errmax <= elist[isucc]:
                    break
                iord[nrmax] = isucc
                nrmax -= 1
        jupbn = last
        if last > limit // 2 + 2:
            jupbn = limit + 3 - last
        errmin = elist[last]
        jbnd = jupbn - 1
        ibeg = nrmax + 1
        i = ibeg
        found = False
        while i <= jbnd:
            isucc = iord[i]
            if errmax >= elist[isucc]:
                found = True
                break
            iord[i - 1] = isucc
            i += 1
        if not found:
            iord[jbnd] = maxerr
            iord[jupbn] = last
        else:
            iord[i - 1] = maxerr
            k = jbnd
            placed = False
            for _ in range(i, jbnd + 1):
                isucc = iord[k]
                if errmin < elist[isucc]:
                    iord[k + 1] = last
                    placed = True
                    break
                iord[k + 1] = isucc
                k -= 1
            if not placed:
                iord[i] = last
    maxerr = iord[nrmax]
    return maxerr, elist[maxerr], nrmax


def _qelg(n, epstab, res3la, nres):
    """QUADPACK's dqelg (Wynn's epsilon algorithm); epstab and res3la are
    1-based lists.  Returns (n, result, abserr, nres)."""
    nres += 1
    abserr = _HUGE
    result = epstab[n]
    if n < 3:
        return n, result, max(abserr, 5 * _EPS * abs(result)), nres
    limexp = 50
    epstab[n + 2] = epstab[n]
    newelm = (n - 1) // 2
    epstab[n] = _HUGE
    num = n
    k1 = n
    for i in range(1, newelm + 1):
        k2 = k1 - 1
        k3 = k1 - 2
        res = epstab[k1 + 2]
        e0 = epstab[k3]
        e1 = epstab[k2]
        e2 = res
        e1abs = abs(e1)
        delta2 = e2 - e1
        err2 = abs(delta2)
        tol2 = max(abs(e2), e1abs) * _EPS
        delta3 = e1 - e0
        err3 = abs(delta3)
        tol3 = max(e1abs, abs(e0)) * _EPS
        if err2 <= tol2 and err3 <= tol3:
            # e0, e1 and e2 are equal to within machine accuracy: converged
            result = res
            abserr = err2 + err3
            return n, result, max(abserr, 5 * _EPS * abs(result)), nres
        e3 = epstab[k1]
        epstab[k1] = e1
        delta1 = e1 - e3
        err1 = abs(delta1)
        tol1 = max(e1abs, abs(e3)) * _EPS
        if err1 <= tol1 or err2 <= tol2 or err3 <= tol3:
            n = i + i - 1
            break
        ss = 1 / delta1 + 1 / delta2 - 1 / delta3
        epsinf = abs(ss * e1)
        if epsinf <= 1e-4:
            n = i + i - 1
            break
        res = e1 + 1 / ss
        epstab[k1] = res
        k1 -= 2
        error = err2 + abs(res - e2) + err3
        if error <= abserr:
            abserr = error
            result = res
    if n == limexp:
        n = 2 * (limexp // 2) - 1
    ib = 1 if num % 2 == 1 else 2
    ie = newelm + 1
    for _ in range(ie):
        ib2 = ib + 2
        epstab[ib] = epstab[ib2]
        ib = ib2
    if num != n:
        indx = num - n + 1
        for i in range(1, n + 1):
            epstab[i] = epstab[indx]
            indx += 1
    if nres < 4:
        res3la[nres] = result
        abserr = _HUGE
    else:
        abserr = abs(result - res3la[3]) + abs(result - res3la[2]) + abs(result - res3la[1])
        res3la[1], res3la[2], res3la[3] = res3la[2], res3la[3], result
    return n, result, max(abserr, 5 * _EPS * abs(result)), nres


def _qags(rule, a, b, epsabs, epsrel, limit, infinite):
    """QUADPACK's dqagse (and, with the 15-point transformed rule, dqagie).
    Returns (result, abserr, neval, ier, last, alist, blist, rlist, elist, iord),
    the lists 1-based."""
    alist = [0.0] * (limit + 1)
    blist = [0.0] * (limit + 1)
    rlist = [0.0] * (limit + 1)
    elist = [0.0] * (limit + 1)
    iord = [0] * (limit + 1)
    level = None
    alist[1], blist[1] = a, b
    npts = 15 if infinite else 21

    def neval_of(last):
        return (30 * last - 15) * (2 if infinite == 2 else 1) if infinite else 42 * last - 21

    if limit < 1 or (epsabs <= 0 and epsrel < max(50 * _EPS, 0.5e-28)):
        return 0.0, 0.0, 0, 6, 0, alist, blist, rlist, elist, iord
    ierro = 0
    ier = 0
    result, abserr, defabs, resabs = rule(a, b)
    dres = abs(result)
    errbnd = max(epsabs, epsrel * dres)
    last = 1
    rlist[1] = result
    elist[1] = abserr
    iord[1] = 1
    if abserr <= 100 * _EPS * defabs and abserr > errbnd:
        ier = 2
    if limit == 1:
        ier = 1
    if ier != 0 or (abserr <= errbnd and abserr != resabs) or abserr == 0:
        return result, abserr, neval_of(last), ier, last, alist, blist, rlist, elist, iord
    rlist2 = [0.0] * 53
    res3la = [0.0] * 4
    rlist2[1] = result
    errmax = abserr
    maxerr = 1
    area = result
    errsum = abserr
    abserr = _HUGE
    nrmax = 1
    nres = 0
    numrl2 = 2
    ktmin = 0
    extrap = False
    noext = False
    iroff1 = iroff2 = iroff3 = 0
    ksgn = 1 if dres >= (1 - 50 * _EPS) * defabs else -1
    small = erlarg = ertest = correc = 0.0
    sum_all = False
    for last in range(2, limit + 1):
        a1 = alist[maxerr]
        b1 = 0.5 * (alist[maxerr] + blist[maxerr])
        a2 = b1
        b2 = blist[maxerr]
        erlast = errmax
        area1, error1, resabs, defab1 = rule(a1, b1)
        area2, error2, resabs, defab2 = rule(a2, b2)
        area12 = area1 + area2
        erro12 = error1 + error2
        errsum = errsum + erro12 - errmax
        area = area + area12 - rlist[maxerr]
        if defab1 != error1 and defab2 != error2:
            if abs(rlist[maxerr] - area12) <= 1e-5 * abs(area12) and erro12 >= 0.99 * errmax:
                if extrap:
                    iroff2 += 1
                else:
                    iroff1 += 1
            if last > 10 and erro12 > errmax:
                iroff3 += 1
        rlist[maxerr] = area1
        rlist[last] = area2
        errbnd = max(epsabs, epsrel * abs(area))
        if iroff1 + iroff2 >= 10 or iroff3 >= 20:
            ier = 2
        if iroff2 >= 5:
            ierro = 3
        if last == limit:
            ier = 1
        if max(abs(a1), abs(b2)) <= (1 + 100 * _EPS) * (abs(a2) + 1000 * _TINY):
            ier = 4
        if error2 > error1:
            alist[maxerr] = a2
            alist[last] = a1
            blist[last] = b1
            rlist[maxerr] = area2
            rlist[last] = area1
            elist[maxerr] = error2
            elist[last] = error1
        else:
            alist[last] = a2
            blist[maxerr] = b1
            blist[last] = b2
            elist[maxerr] = error1
            elist[last] = error2
        maxerr, errmax, nrmax = _qpsrt(limit, last, maxerr, elist, iord, nrmax)
        if errsum <= errbnd:
            sum_all = True
            break
        if ier != 0:
            break
        if last == 2:
            small = 0.375 if infinite else abs(b - a) * 0.375
            erlarg = errsum
            ertest = errbnd
            rlist2[2] = area
            continue
        if noext:
            continue
        erlarg -= erlast
        if abs(b1 - a1) > small:
            erlarg += erro12
        if not extrap:
            # is the interval to bisect next the smallest one?
            if abs(blist[maxerr] - alist[maxerr]) > small:
                continue
            extrap = True
            nrmax = 2
        skip = False
        if ierro != 3 and erlarg > ertest:
            # the smallest interval has the largest error: before bisecting,
            # decrease the error over the larger intervals (erlarg), and extrapolate
            jupbnd = last
            if last > 2 + limit // 2:
                jupbnd = limit + 3 - last
            for _ in range(nrmax, jupbnd + 1):
                maxerr = iord[nrmax]
                errmax = elist[maxerr]
                if abs(blist[maxerr] - alist[maxerr]) > small:
                    skip = True
                    break
                nrmax += 1
        if skip:
            continue
        numrl2 += 1
        rlist2[numrl2] = area
        numrl2, reseps, abseps, nres = _qelg(numrl2, rlist2, res3la, nres)
        ktmin += 1
        if ktmin > 5 and abserr < 1e-3 * errsum:
            ier = 5
        if abseps < abserr:
            ktmin = 0
            abserr = abseps
            result = reseps
            correc = erlarg
            ertest = max(epsabs, epsrel * abs(reseps))
            if abserr <= ertest:
                break
        # prepare to bisect the smallest interval
        if numrl2 == 1:
            noext = True
        if ier == 5:
            break
        maxerr = iord[1]
        errmax = elist[maxerr]
        nrmax = 1
        extrap = False
        small *= 0.5
        erlarg = errsum
    if not sum_all:
        # the final result and error estimate (label 100)
        if abserr == _HUGE:
            sum_all = True
        elif ier + ierro != 0:
            if ierro == 3:
                abserr += correc
            if ier == 0:
                ier = 3
            goto = None
            if result != 0 and area != 0:
                goto = 115 if abserr / abs(result) > errsum / abs(area) else 110
            elif abserr > errsum:
                goto = 115
            elif area == 0:
                goto = 130
            else:
                goto = 110
            if goto == 115:
                sum_all = True
            elif goto == 110:
                if not (ksgn == -1 and max(abs(result), abs(area)) <= defabs * 0.01):
                    if 0.01 > result / area or result / area > 100 or errsum > abs(area):
                        ier = 6
        else:
            # label 110: the test on divergence
            if not (ksgn == -1 and max(abs(result), abs(area)) <= defabs * 0.01):
                if 0.01 > result / area or result / area > 100 or errsum > abs(area):
                    ier = 6
    if sum_all:
        result = 0.0
        for k in range(1, last + 1):
            result += rlist[k]
        abserr = errsum
    if ier > 2:
        ier -= 1
    return result, abserr, neval_of(last), ier, last, alist, blist, rlist, elist, iord


_QUAD_MSGS = {
    1: "The maximum number of subdivisions (%d) has been achieved.\n  If increasing the limit yields no "
       "improvement it is advised to analyze \n  the integrand in order to determine the difficulties.  If the "
       "position of a \n  local difficulty can be determined (singularity, discontinuity) one will \n  probably "
       "gain from splitting up the interval and calling the integrator \n  on the subranges.  Perhaps a "
       "special-purpose integrator should be used.",
    2: "The occurrence of roundoff error is detected, which prevents \n  the requested tolerance from being "
       "achieved.  The error may be \n  underestimated.",
    3: "Extremely bad integrand behavior occurs at some points of the\n  integration interval.",
    4: "The algorithm does not converge.  Roundoff error is detected\n  in the extrapolation table.  It is assumed "
       "that the requested tolerance\n  cannot be achieved, and that the returned result (if full_output = 1) is "
       "\n  the best which can be obtained.",
    5: "The integral is probably divergent, or slowly convergent.",
}


def quad(func, a, b, args=(), full_output=0, epsabs=1.49e-08, epsrel=1.49e-08, limit=50, points=None,
         weight=None, wvar=None, wopts=None, maxp1=50, limlst=50, complex_func=False):
    """The integral of func(x, *args) from a to b (either may be infinite):
    returns (value, abserr), an estimate of the absolute error.

    This is QUADPACK's QAGS (adaptive 21-point Gauss-Kronrod with the
    epsilon algorithm) and, for infinite limits, QAGI, as in SciPy.  It stops
    when abserr <= max(epsabs, epsrel*|value|), after at most limit
    subintervals; otherwise it warns (IntegrationWarning).  With
    full_output=True it also returns an infodict (neval, last, alist, blist,
    rlist, elist, iord).  complex_func=True integrates the real and imaginary
    parts.  points and weight are not implemented.

    >>> quad(lambda x: x**2, 0, 1)
    """
    if points is not None:
        _unsupported("quad", "points (QUADPACK's QAGP)", "split the interval at the points and add the integrals")
    if weight is not None:
        _unsupported("quad", "weight=%r (QUADPACK's weighted rules)" % (weight,))
    if not isinstance(args, tuple):
        args = (args,)
    if a == b:
        nan = math.nan
        info = {"neval": 0, "last": 0, "alist": np.full(limit, nan), "blist": np.full(limit, nan),
                "rlist": np.zeros(limit), "elist": np.zeros(limit), "iord": np.zeros(limit, dtype=np.int32)}
        if not full_output:
            return 0.0, 0.0
        return (0j, 0j, {"real": info, "imag": info}) if complex_func else (0.0, 0.0, info)
    if complex_func:
        re = quad(lambda x, *ar: complex(func(x, *ar)).real, a, b, args, full_output, epsabs, epsrel, limit)
        im = quad(lambda x, *ar: complex(func(x, *ar)).imag, a, b, args, full_output, epsabs, epsrel, limit)
        r = (re[0] + 1j * im[0], re[1] + 1j * im[1])
        if full_output:
            r = r + ({"real": re[2:], "imag": im[2:]},)
        return r
    a = float(a)
    b = float(b)
    flip = b < a
    a, b = min(a, b), max(a, b)

    def f(x):
        v = func(x, *args)
        try:
            return float(v)
        except TypeError:
            raise TypeError("quad: the integrand must return a real number (got %s); for complex values use "
                            "complex_func=True" % type(v).__name__) from None

    inf = 0
    if b != math.inf and a != -math.inf:
        r = _qags(lambda u, v: _qk21(f, u, v), a, b, epsabs, epsrel, limit, 0)
    else:
        if b == math.inf and a != -math.inf:
            inf, bound = 1, a
        elif b == math.inf and a == -math.inf:
            inf, bound = 2, 0.0
        else:
            inf, bound = -1, b
        r = _qags(lambda u, v: _qk15i(f, bound, inf, u, v), 0.0, 1.0, epsabs, epsrel, limit, inf)
    result, abserr, neval, ier, last, alist, blist, rlist, elist, iord = r
    if ier == 6:
        if epsabs <= 0 and epsrel < max(50 * _EPS, 5e-29):
            raise ValueError("If 'epsabs'<=0, 'epsrel' must be greater than both 5e-29 and 50*(machine epsilon).")
        raise ValueError("Invalid 'limit' argument. There must be at least one subinterval")
    if flip:
        result = -result
    out = (result, abserr)
    if full_output:
        def pad(v, fill):
            return np.array(v[1:last + 1] + [fill] * (limit - last))
        info = {"neval": neval, "last": last, "alist": pad(alist, 0.0), "blist": pad(blist, 0.0),
                "rlist": pad(rlist, 0.0), "elist": pad(elist, 0.0),
                "iord": np.array([max(v - 1, 0) for v in iord[1:last + 1]] + [0] * (limit - last), dtype=np.int32)}
        out = out + (info,)
    if ier == 0:
        return out
    msg = _QUAD_MSGS[ier] % limit if ier == 1 else _QUAD_MSGS.get(ier, "Unknown error.")
    if full_output:
        return out + (msg,)
    warnings.warn(msg, IntegrationWarning, stacklevel=2)
    return out


def nquad(func, ranges, args=None, opts=None, full_output=False):
    """The integral of func(x0, x1, ..., *args) over several variables, by
    quad in each (as SciPy's nquad): ranges[i] is [lo, hi] or a function of
    the outer variables (and args) giving it, ranges[0] the innermost; opts
    are quad's options (one dict, or one per variable, or functions).
    Returns (value, abserr), abserr the largest of the quad calls'."""
    depth = len(ranges)
    rfuncs = [r if callable(r) else (lambda *a, r=r: r) for r in ranges]
    args = () if args is None else tuple(args)
    if opts is None:
        ofuncs = [lambda *a: {}] * depth
    elif isinstance(opts, dict):
        ofuncs = [lambda *a: opts] * depth
    else:
        ofuncs = [o if callable(o) else (lambda *a, o=o: o) for o in opts]
    state = {"abserr": 0, "neval": 0}

    def integrate(*xs, depth_=0):
        ind = -(depth_ + 1)
        low, high = rfuncs[ind](*xs)
        opt = dict(ofuncs[ind](*xs))
        if "points" in opt:
            opt["points"] = [p for p in opt["points"] if low <= p <= high]
        f = func if depth_ + 1 == depth else (lambda *a: integrate(*a, depth_=depth_ + 1))
        r = quad(f, low, high, args=xs, full_output=full_output, **opt)
        if full_output and depth_ + 1 == depth:
            state["neval"] += r[2]["neval"]
        state["abserr"] = max(state["abserr"], r[1])
        if depth_ > 0:
            return r[0]
        return (r[0], state["abserr"], {"neval": state["neval"]}) if full_output else (r[0], state["abserr"])
    return integrate(*args)


def dblquad(func, a, b, gfun, hfun, args=(), epsabs=1.49e-08, epsrel=1.49e-08):
    """The double integral of func(y, x, *args) for x from a to b and y from
    gfun(x) to hfun(x) (numbers or functions of x): returns (value, abserr)."""
    def yrange(*a):
        return [gfun(a[0]) if callable(gfun) else gfun, hfun(a[0]) if callable(hfun) else hfun]
    return nquad(func, [yrange, [a, b]], args=args, opts={"epsabs": epsabs, "epsrel": epsrel})


def tplquad(func, a, b, gfun, hfun, qfun, rfun, args=(), epsabs=1.49e-08, epsrel=1.49e-08):
    """The triple integral of func(z, y, x, *args) for x from a to b, y from
    gfun(x) to hfun(x) and z from qfun(x, y) to rfun(x, y): returns
    (value, abserr)."""
    def zrange(*a):
        return [qfun(a[1], a[0]) if callable(qfun) else qfun, rfun(a[1], a[0]) if callable(rfun) else rfun]

    def yrange(*a):
        return [gfun(a[0]) if callable(gfun) else gfun, hfun(a[0]) if callable(hfun) else hfun]
    return nquad(func, [zrange, yrange, [a, b]], args=args, opts={"epsabs": epsabs, "epsrel": epsrel})


# ---------------------------------------------------------------- samples: trapezoid, simpson

def _along(y, axis):
    """slices of y along axis as a function of a slice."""
    nd = y.ndim
    axis = axis % nd if nd else 0

    def sl(s):
        idx = [slice(None)] * nd
        idx[axis] = s
        return tuple(idx)
    return sl, axis


def trapezoid(y, x=None, dx=1.0, axis=-1):
    """The integral of samples y along axis by the trapezoidal rule, at the
    points x (or spacing dx)."""
    y = np.asarray(y)
    if y.dtype.kind in "biu":
        y = y.astype(float)
    sl, axis = _along(y, axis)
    if x is None:
        d = dx
    else:
        x = np.asarray(x)
        if x.ndim == 1:
            d = x[1:] - x[:-1]
            shape = [1] * y.ndim
            shape[axis] = d.shape[0]
            d = d.reshape(tuple(shape))
        else:
            x = np.broadcast_to(x, y.shape)
            d = x[sl(slice(1, None))] - x[sl(slice(None, -1))]
    return (d * (y[sl(slice(1, None))] + y[sl(slice(None, -1))]) / 2.0).sum(axis)


def cumulative_trapezoid(y, x=None, dx=1.0, axis=-1, initial=None):
    """The running integral of samples y by the trapezoidal rule; initial=0
    puts a 0 first, so the result has the length of y."""
    y = np.asarray(y)
    sl, axis = _along(y, axis)
    if y.shape[axis] == 0:
        raise ValueError("At least one point is required along `axis`.")
    if x is None:
        d = dx
    else:
        x = np.asarray(x)
        if x.ndim == 1:
            d = np.diff(x)
            shape = [1] * y.ndim
            shape[axis] = -1
            d = d.reshape(tuple(shape))
        elif len(x.shape) != len(y.shape):
            raise ValueError("If given, shape of x must be 1-D or the same as y.")
        else:
            d = np.diff(x, axis=axis)
        if d.shape[axis] != y.shape[axis] - 1:
            raise ValueError("If given, length of x along axis must be the same as y.")
    res = np.cumsum(d * (y[sl(slice(1, None))] + y[sl(slice(None, -1))]) / 2.0, axis=axis)
    if initial is not None:
        if initial != 0:
            raise ValueError("`initial` must be `None` or `0`.")
        if np.asarray(initial).ndim != 0:
            raise ValueError("`initial` parameter should be a scalar.")
        shape = list(res.shape)
        shape[axis] = 1
        res = np.concatenate((np.full(tuple(shape), initial, dtype=res.dtype), res), axis=axis)
    return res


def _basic_simpson(y, start, stop, x, dx, axis, sl):
    s0 = sl(slice(start, stop, 2))
    s1 = sl(slice(start + 1, stop + 1, 2))
    s2 = sl(slice(start + 2, stop + 2, 2))
    if x is None:
        return dx / 3.0 * np.sum(y[s0] + 4.0 * y[s1] + y[s2], axis=axis)
    h = np.diff(x, axis=axis)
    h0 = h[sl(slice(start, stop, 2))]
    h1 = h[sl(slice(start + 1, stop + 1, 2))]
    hsum = h0 + h1
    hprod = h0 * h1
    with np.errstate(divide="ignore", invalid="ignore"):
        h0divh1 = np.where(h1 != 0, h0 / np.where(h1 != 0, h1, 1.0), 0.0)
        inv = np.where(h0divh1 != 0, 1.0 / np.where(h0divh1 != 0, h0divh1, 1.0), 0.0)
        hh = np.where(hprod != 0, hsum / np.where(hprod != 0, hprod, 1.0), 0.0)
    tmp = hsum / 6.0 * (y[s0] * (2.0 - inv) + y[s1] * (hsum * hh) + y[s2] * (2.0 - h0divh1))
    return np.sum(tmp, axis=axis)


def simpson(y, x=None, *, dx=1.0, axis=-1):
    """The integral of samples y along axis by Simpson's rule, at the points
    x (or spacing dx).  With an even number of samples, the last interval
    uses Cartwright's correction, as in SciPy 1.11 and later."""
    y = np.asarray(y, dtype=float)
    sl, axis = _along(y, axis)
    nd = y.ndim
    N = y.shape[axis]
    last_dx = dx
    if x is not None:
        x = np.asarray(x, dtype=float)
        if x.ndim == 1:
            shapex = [1] * nd
            shapex[axis] = x.shape[0]
            x = x.reshape(tuple(shapex))
        elif x.ndim != y.ndim:
            raise ValueError("If given, shape of x must be 1-D or the same as y.")
        if x.shape[axis] != N:
            raise ValueError("If given, length of x along axis must be the same as y.")
    if N % 2 == 0:
        val = 0.0
        result = 0.0
        if N == 2:
            if x is not None:
                last_dx = x[sl(-1)] - x[sl(-2)]
            val = 0.5 * last_dx * (y[sl(-1)] + y[sl(-2)])
        else:
            result = _basic_simpson(y, 0, N - 3, x, dx, axis, sl)
            if x is not None:
                diffs = np.diff(x, axis=axis)
                h = [diffs[sl(-2)], diffs[sl(-1)]]
            else:
                h = [dx, dx]

            def div(num, den):
                return np.where(den != 0, num / np.where(den != 0, den, 1.0), 0.0) if isinstance(den, np.ndarray) \
                    else (num / den if den != 0 else 0.0)
            alpha = div(2 * h[1] ** 2 + 3 * h[0] * h[1], 6 * (h[1] + h[0]))
            beta = div(h[1] ** 2 + 3.0 * h[0] * h[1], 6 * h[0])
            eta = div(1 * h[1] ** 3, 6 * h[0] * (h[0] + h[1]))
            result = result + (alpha * y[sl(-1)] + beta * y[sl(-2)] - eta * y[sl(-3)])
        result = result + val
    else:
        result = _basic_simpson(y, 0, N - 2, x, dx, axis, sl)
    return result
