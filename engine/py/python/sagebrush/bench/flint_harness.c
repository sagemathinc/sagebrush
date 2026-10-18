/* FLINT as a competitor of sagebrush bench: a separate process, written
 * against FLINT's documented interface only (fmpz_mat, fmpz_poly). It is
 * compiled on the user's machine against the FLINT found there, never
 * shipped compiled and never linked into Sagebrush.
 *
 * One request per line on stdin, integers in decimal:
 *   det R n a_11 ... a_nn            solve R n a_11 ... a_nn b_1 ... b_n
 *   inverse R n a_11 ... a_nn        charpoly R n a_11 ... a_nn
 *   rref R r c a_11 ... a_rc         mul R la a_0 ... lb b_0 ...
 *   gcd R la a_0 ... lb b_0 ...      (polynomials constant term first)
 * R is the number of samples. The reply is "T t_1 ... t_R calls" (seconds
 * per call), "A k:f" (the answer's k rational entries q_i, fingerprinted as
 * sum q_i 1000003^i modulo 2^61 - 1) or "E message", then "END".
 *
 * Timing is that of sagebrush.bench._timing: one call; a call of 10 s or
 * more is timed once; else calls per sample raised until they take 0.1 s;
 * then R samples. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <flint/fmpz.h>
#include <flint/fmpz_mat.h>
#include <flint/fmpz_poly.h>

typedef unsigned long long u64;
static const u64 P = 2305843009213693951ULL; /* 2^61 - 1 */
static const u64 BASE = 1000003ULL;

static u64 mulmod(u64 a, u64 b) { return (u64)(((unsigned __int128)a * b) % P); }

static u64 powmod(u64 a, u64 e) {
    u64 r = 1;
    for (; e; e >>= 1, a = mulmod(a, a))
        if (e & 1) r = mulmod(r, a);
    return r;
}

static u64 fmod_p(const fmpz_t x) { return (u64)fmpz_fdiv_ui(x, P); }

/* the running fingerprint of a list of rationals num/den */
typedef struct { u64 f, w; long k; } fp_t;
static void fp_init(fp_t *s) { s->f = 0; s->w = 1; s->k = 0; }
static void fp_add(fp_t *s, const fmpz_t num, const fmpz_t den) {
    u64 d = fmod_p(den);
    u64 q = mulmod(fmod_p(num), d ? powmod(d, P - 2) : 0);
    s->f = (s->f + mulmod(q, s->w)) % P;
    s->w = mulmod(s->w, BASE);
    s->k++;
}

static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + 1e-9 * t.tv_nsec;
}

/* the request, parsed once */
static char *op;
static long reps;
static fmpz_mat_t A, B;
static fmpz_poly_t pa, pb;
static int ok;
static fp_t ans;

/* one call of the operation; with `answer`, its fingerprint into ans */
static void run(int answer) {
    fmpz_t den, one;
    fmpz_init(den);
    fmpz_init_set_ui(one, 1);
    if (answer) fp_init(&ans);
    ok = 1;
    if (!strcmp(op, "det")) {
        fmpz_t d;
        fmpz_init(d);
        fmpz_mat_det(d, A);
        if (answer) fp_add(&ans, d, one);
        fmpz_clear(d);
    } else if (!strcmp(op, "solve") || !strcmp(op, "inverse")) {
        fmpz_mat_t X;
        int solve = !strcmp(op, "solve");
        fmpz_mat_init(X, fmpz_mat_nrows(A), solve ? 1 : fmpz_mat_ncols(A));
        ok = solve ? fmpz_mat_solve(X, den, A, B) : fmpz_mat_inv(X, den, A);
        if (answer && ok)
            for (slong i = 0; i < fmpz_mat_nrows(X); i++)
                for (slong j = 0; j < fmpz_mat_ncols(X); j++) fp_add(&ans, fmpz_mat_entry(X, i, j), den);
        fmpz_mat_clear(X);
    } else if (!strcmp(op, "charpoly")) {
        fmpz_poly_t c;
        fmpz_poly_init(c);
        fmpz_mat_charpoly(c, A);
        if (answer)
            for (slong i = 0; i < fmpz_poly_length(c); i++) {
                fmpz_t x;
                fmpz_init(x);
                fmpz_poly_get_coeff_fmpz(x, c, i);
                fp_add(&ans, x, one);
                fmpz_clear(x);
            }
        fmpz_poly_clear(c);
    } else if (!strcmp(op, "rref")) {
        fmpz_mat_t R;
        fmpz_mat_init(R, fmpz_mat_nrows(A), fmpz_mat_ncols(A));
        fmpz_mat_rref(R, den, A);
        if (answer)
            for (slong i = 0; i < fmpz_mat_nrows(R); i++)
                for (slong j = 0; j < fmpz_mat_ncols(R); j++) fp_add(&ans, fmpz_mat_entry(R, i, j), den);
        fmpz_mat_clear(R);
    } else if (!strcmp(op, "mul") || !strcmp(op, "gcd")) {
        fmpz_poly_t c;
        fmpz_poly_init(c);
        if (!strcmp(op, "mul")) fmpz_poly_mul(c, pa, pb);
        else fmpz_poly_gcd(c, pa, pb);
        if (answer)
            for (slong i = 0; i < fmpz_poly_length(c); i++) {
                fmpz_t x;
                fmpz_init(x);
                fmpz_poly_get_coeff_fmpz(x, c, i);
                fp_add(&ans, x, one);
                fmpz_clear(x);
            }
        fmpz_poly_clear(c);
    }
    fmpz_clear(den);
    fmpz_clear(one);
}

static char *tok(void) { return strtok(NULL, " \t\r\n"); }

static int read_int(fmpz_t x) {
    char *t = tok();
    return t && fmpz_set_str(x, t, 10) == 0;
}

static int read_mat(fmpz_mat_t M, slong r, slong c) {
    for (slong i = 0; i < r; i++)
        for (slong j = 0; j < c; j++)
            if (!read_int(fmpz_mat_entry(M, i, j))) return 0;
    return 1;
}

static int read_poly(fmpz_poly_t f) {
    char *t = tok();
    long n = t ? atol(t) : -1;
    if (n < 0) return 0;
    for (long i = 0; i < n; i++) {
        fmpz_t x;
        fmpz_init(x);
        if (!read_int(x)) return 0;
        fmpz_poly_set_coeff_fmpz(f, i, x);
        fmpz_clear(x);
    }
    return 1;
}

int main(void) {
    char *line = NULL;
    size_t cap = 0;
    while (getline(&line, &cap, stdin) > 0) {
        op = strtok(line, " \t\r\n");
        if (!op) continue;
        char *t = tok();
        reps = t ? atol(t) : 0;
        int parsed = reps >= 1, mat = 0, poly = 0;
        if (parsed && (!strcmp(op, "det") || !strcmp(op, "solve") || !strcmp(op, "inverse") || !strcmp(op, "charpoly"))) {
            long n = (t = tok()) ? atol(t) : 0;
            if (n < 1) n = 1, parsed = 0;
            fmpz_mat_init(A, n, n);
            fmpz_mat_init(B, n, 1);
            mat = 1;
            parsed = parsed && read_mat(A, n, n);
            if (parsed && !strcmp(op, "solve"))
                for (long i = 0; i < n && parsed; i++) parsed = read_int(fmpz_mat_entry(B, i, 0));
        } else if (parsed && !strcmp(op, "rref")) {
            long r = (t = tok()) ? atol(t) : 0, c = (t = tok()) ? atol(t) : 0;
            if (r < 1 || c < 1) r = c = 1, parsed = 0;
            fmpz_mat_init(A, r, c);
            fmpz_mat_init(B, 1, 1);
            mat = 1;
            parsed = parsed && read_mat(A, r, c);
        } else if (parsed && (!strcmp(op, "mul") || !strcmp(op, "gcd"))) {
            fmpz_poly_init(pa);
            fmpz_poly_init(pb);
            poly = 1;
            parsed = read_poly(pa) && read_poly(pb);
        } else {
            parsed = 0;
        }
        if (!parsed) {
            printf("E bad request %s\n", op);
        } else {
            double t0 = now();
            run(1);
            double dt = now() - t0;
            long calls = 1;
            double *s = malloc(sizeof(double) * reps);
            if (dt >= 10.0) {
                reps = 1;
                s[0] = dt;
            } else {
                while (dt < 0.1) {
                    long m = dt <= 0 ? calls * 10 : (long)(calls * 1.2 * 0.1 / dt) + 1;
                    calls = m > calls + 1 ? m : calls + 1;
                    t0 = now();
                    for (long i = 0; i < calls; i++) run(0);
                    dt = now() - t0;
                }
                for (long j = 0; j < reps; j++) {
                    t0 = now();
                    for (long i = 0; i < calls; i++) run(j == reps - 1 && i == calls - 1);
                    s[j] = (now() - t0) / calls;
                }
            }
            if (!ok) {
                printf("E singular\n");
            } else {
                printf("T");
                for (long j = 0; j < reps; j++) printf(" %.9g", s[j]);
                printf(" %ld\nA %ld:%llu\n", calls, ans.k, ans.f);
            }
            free(s);
        }
        if (mat) { fmpz_mat_clear(A); fmpz_mat_clear(B); }
        if (poly) { fmpz_poly_clear(pa); fmpz_poly_clear(pb); }
        printf("END\n");
        fflush(stdout);
    }
    free(line);
    return 0;
}
