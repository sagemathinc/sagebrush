# Writes test/ld80-oracle.json: R's own sum, prod, mean, cumsum and cumprod of a set of double vectors, every
# value as a C99 hex float, for test/ld80.test.ts.  Run with R 4.5.3 on x86-64 Linux (R's long double is the
# 80-bit format only there): Rscript test/ld80_oracle.R > test/ld80-oracle.json
set.seed(2321)
h <- function(v) paste0('"', ifelse(is.na(v) & !is.nan(v), "NA", sprintf("%a", v)), '"', collapse = ",")
cases <- list()
add <- function(x) cases[[length(cases) + 1]] <<- x
mag <- function(n, lo, hi) sample(c(-1, 1), n, TRUE) * 2^runif(n, lo, hi) * (1 + runif(n))
# cancellation and spread magnitudes
for (i in 1:30) { a <- mag(sample(1:6, 1), -70, 70); add(sample(c(a, -a[1], mag(sample(1:4, 1), -70, 70)))) }
# bits just below a double's: 1 + tiny steps
for (i in 1:15) add(c(1, sample(c(-1, 1), 8, TRUE) * 2^-sample(53:75, 8, TRUE), -1)[1:sample(3:10, 1)])
# near the largest double, and the extended range past it
for (i in 1:10) add(sample(c(.Machine$double.xmax * runif(3, 0.5, 1), -.Machine$double.xmax * runif(2, 0.5, 1))))
# subnormals
for (i in 1:10) add(sample(c(-1, 1), 6, TRUE) * 2^-1074 * sample(1:2^20, 6))
# products across the extended exponent range: overflow at 2^16384, gradual underflow to 2^-16445
for (i in 1:20) add(2^runif(sample(8:24, 1), -1023, 1023) * (1 + runif(1)))
for (i in 1:10) { k <- sample(14:18, 1); add(c(rep(2^(1000 + runif(1)), k), rep(2^-(1000 + runif(1)), k))) }
for (i in 1:10) { k <- sample(14:18, 1); add(c(rep(2^-(1000 + runif(1)), k), rep(2^(1000 + runif(1)), k))) }
for (i in 1:10) add(c(rep(2^-1022, 16), 2^-runif(1, 0, 60) * (1 + 2^-52 * sample(0:9, 1)), 2^1023, 2^1023))
# zeros and signs
add(c(-0, -0)); add(c(0, -0)); add(-0); add(c(1, -1)); add(c(-1, 1, -0))
# missing values and infinities, as R meets them
pool <- c(NA, NaN, Inf, -Inf, 1, -2.5, 0, 1e308)
for (i in 1:40) add(sample(pool, sample(1:7, 1), TRUE))
cat("[\n")
for (i in seq_along(cases)) {
  x <- cases[[i]]
  cat(sprintf('{"x":[%s],"sum":%s,"prod":%s,"mean":%s,"cumsum":[%s],"cumprod":[%s]}%s\n', h(x), h(sum(x)), h(prod(x)), h(mean(x)),
              h(cumsum(x)), h(cumprod(x)), if (i < length(cases)) "," else ""))
}
cat("]\n")
