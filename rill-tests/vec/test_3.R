#-- sum-types
sum(1:10); typeof(sum(1:3)); typeof(sum(TRUE, FALSE, TRUE)); sum(); typeof(sum()); sum(1:3, 2.5); sum(NULL)
#-- sum-doubles
sum(c(0.1, 0.2, 0.3)); print(sum(c(0.1, 0.2, 0.3)), digits = 17); sum(c(1e308, 1e308)); sum(c(1e308, 1e308, -1e308))
#-- sum-extended-precision
print(sum(c(1, 1e-16, 1e-16, 1e-16, 1e-16)), digits = 17); print(sum(c(1e16, 1, 1, 1, -1e16)), digits = 17)
#-- sum-integer-overflow
x <- sum(2147483647L, 1L)
typeof(x); x
#-- sum-na
sum(c(1, NA)); sum(c(1, NA), na.rm = TRUE); sum(c(NA, NaN)); sum(c(NaN, NA)); sum(c(1, NaN, NA)); sum(c(NA, 1L)); sum(1:3, NA, na.rm = TRUE)
#-- sum-inf
sum(c(Inf, 1)); sum(c(Inf, -Inf)); sum(c(-Inf, -1))
#-- sum-complex
sum(1+2i, 3); sum(c(1i, 2i))
#-- sum-named
sum(c(a = 1, b = 2))
#-- sum-error-character
sum("a")
#-- prod
prod(1:5); typeof(prod(1:5)); prod(); prod(1:3, 2:3); prod(c(2, NA), na.rm = TRUE); prod(c(2, NA)); prod(c(0.1, 0.2, 0.3))
#-- prod-special
prod(c(Inf, 2)); prod(c(Inf, 0)); prod(c(-2, 0)); prod(c(-1, -Inf)); prod(c(1e200, 1e200)); prod(c(1e200, 1e200, 1e-200))
#-- prod-error-character
prod("a")
#-- min-max
min(3:1); typeof(min(3:1)); max(c(2.5, 1), 4L); typeof(max(1L, 2.5)); max(c(a = 1, b = 5)); min(c(TRUE, FALSE)); typeof(min(c(TRUE, FALSE)))
#-- min-max-na
max(c(1, NA, 3)); max(c(1, NA, 3), na.rm = TRUE); min(c(NaN, 1)); min(c(NA, NaN)); min(c(NaN, NA)); max(1:3, NA_integer_); typeof(max(1:3, NA_integer_))
#-- min-max-character
min(c("b", "a", "c")); max(c("apple", "Banana")); min(1, "a"); max(2, c("10", "9"))
#-- min-empty
min(integer(0))
#-- max-empty
max(numeric(0))
#-- max-null
max(NULL)
#-- max-empty-inf
max(integer(0), -Inf)
#-- min-error-complex
min(1i)
#-- mean
mean(1:4); typeof(mean(1:4)); mean(c(1.5, 2.5, 10)); mean(c(TRUE, FALSE)); mean(c(1+1i, 2))
#-- mean-na
mean(c(1, NA)); mean(c(1, NA), na.rm = TRUE); mean(c(NaN, NA)); mean(c(NA, NaN)); mean(c(NaN, 1)); mean(numeric(0))
#-- mean-exact
print(mean(c(1, 2, 3, 4) / 3), digits = 17); mean(c(1e308, 1e308)); mean(c(-1e308, 1e308, 1e308)); mean(c(Inf, 1)); mean(c(Inf, -Inf))
#-- mean-trim
mean(1:10, trim = 0.1); mean(c(1, 100, 2, 3), trim = 0.25); mean(1:10, trim = 0.5); mean(c(5, 1, 3), trim = 0.6); mean(c(1, 2), 3)
#-- mean-character
mean("a")
#-- mean-missing
mean()
#-- sum-several-arguments
sum(0.1, 0.2, 0.3) == 0.6; sum(c(0.1, 0.2), 0.3) == 0.6; sum(c(0.1, 0.2, 0.3)) == 0.6; print(sum(0.1, 0.2, 0.3), digits = 17)
sum(1e308, 1e308, -1e308); sum(c(1e308, 1e308), -1e308); sum(1L, 2.5, c(1e308, 1e308, -1e308))
#-- sum-integer-range
typeof(sum(2147483646L, 1L)); x <- sum(1L, 2147483647L, -5L); typeof(x); x; typeof(sum(c(1L, 2147483647L, -5L))); typeof(sum(-2147483647L, -1L, 5L)); typeof(sum(TRUE, 2147483647L))
#-- prod-several-arguments
prod(1e200, 1e200, 1e-200); prod(c(1e200, 1e200, 1e-200)); 1/prod(-1, 0)
#-- mean-trim-fraction
mean(c(1:9, 100), trim = 0.15)
#-- mean-two-pass
mean(c(1e20, 1, -1e20)); mean(c(-1e308, 1e308, 1e308)); print(mean(c(0.1, 0.2, 0.3)), digits = 17)
print(mean(c(3, 0.3, 1e16, 1e16, 1e16, 0.7, 0.2, 3, 0.2, 0.1)), digits = 17)
#-- sum-integer-low-edge
x <- sum(-2147483647L, -1L); typeof(x); print(x, digits = 15)
#-- sum-integer-argument-overflow
x <- sum(c(2147483647L, 1L), -5L); typeof(x); x; typeof(sum(c(2147483647L, 1L), -1L))
x <- sum(-5L, c(2147483647L, 1L)); typeof(x); x; typeof(sum(5L, c(-2147483647L, -1L))); typeof(sum(c(2147483647L, 2147483647L), c(-2147483647L, -2147483647L)))
x <- sum(c(2147483647L, 1L), NA); typeof(x); x; typeof(sum(2147483647L, NA, 1L)); typeof(sum(NA, c(2147483647L, 1L)))
#-- prod-zero-sign
1/prod(c(-1, 0)); 1/prod(c(-1, -1, 0)); 1/prod(c(0, -2), 3); 1/prod(c(-0, 2)); 1/prod(c(-0, -0))
#-- mean-trim-rounding
mean(c(1, 2, 3, 4, 10, 20, 30, 40, 50, 1000), trim = 0.15); mean(1:7, trim = 0.2)
#-- prod-extended-range
prod(c(rep(1e300, 20), rep(1e-300, 20))); prod(c(rep(1e-300, 20), rep(1e300, 20))); print(prod(c(rep(1e300, 16), rep(1e-300, 16))), digits = 17); prod(c(rep(1e300, 17), rep(1e-300, 17)))
print(prod(c(rep(1e300, 16), 1.18e132, rep(1e-300, 16))), digits = 17); prod(c(rep(1e300, 16), 1.19e132, rep(1e-300, 16))); prod(c(rep(1e-300, 17), rep(1e300, 17)))
#-- prod-subnormal
print(prod(c(rep(1e-300, 16), 1e-150, rep(1e300, 16))), digits = 17); print(prod(c(rep(1e-300, 16), 1e-145, rep(1e300, 16))), digits = 17); prod(c(rep(1e-300, 16), 1.8e-151, rep(1e300, 16)))
print(prod(c(rep(1e-300, 16), 1.9e-151, rep(1e300, 16))), digits = 17); 1/prod(c(rep(-1e-300, 17), rep(1e300, 17))); prod(c(rep(-1e300, 17), rep(1e-300, 17)))
#-- prod-overflow-nan
prod(c(rep(1e300, 17), 0)); prod(c(rep(1e-300, 17), Inf)); prod(c(1e300, 1e300), 0); prod(rep(1e300, 17), c(0, NA))
#-- sum-prod-na-order
sum(NaN, NA); sum(NA, NaN); sum(c(NaN, 1), c(2, NA)); sum(c(NA, 1), NaN); sum(NaN, NA_integer_); sum(c(Inf, -Inf), NA); sum(c(Inf, -Inf, NA)); sum(c(Inf, -Inf), c(NA, 1)); sum(NaN, c(NA, 1L))
prod(NaN, NA); prod(NA, NaN); prod(c(NaN, NA)); prod(c(NA, NaN)); prod(NaN, NA_integer_); prod(NA_integer_, NaN); prod(c(Inf, 0), NA); prod(NA, c(Inf, 0)); prod(c(Inf, 0, NA))
#-- sum-overflow
sum(c(1e308, 1e308)); sum(1e308, 1e308); sum(c(1e308, 1e308), -Inf); sum(c(rep(1e308, 10), -rep(1e308, 10)))
#-- sum-complex-na-rm
z <- complex(real = c(NaN, 1), imaginary = c(2, 3)); w <- complex(real = c(1, NA), imaginary = c(NaN, 1))
sum(z); sum(z, na.rm = TRUE); sum(w); sum(w, na.rm = TRUE); sum(c(1+2i, NA), na.rm = TRUE); sum(1i, NaN, na.rm = TRUE)
#-- mean-complex-na
z <- complex(real = c(NaN, 1), imaginary = c(2, 3)); w <- complex(real = c(1, NA), imaginary = c(NaN, 1))
mean(z); mean(z, na.rm = TRUE); mean(w); mean(w, na.rm = TRUE); mean(complex(0)); mean(c(1+2i, NA), na.rm = TRUE); mean(complex(0), trim = 0.1)
v <- c(3, 0.3, 1e16, 1e16, 1e16, 0.7, 0.2, 3, 0.2, 0.1); print(mean(complex(real = v, imaginary = v)), digits = 17)
#-- mean-complex-trim-error
mean(c(1+1i, 2+0i), trim = 0.1)
#-- mean-trim-na
mean(c(NaN, 1, 2), trim = 0.1); mean(c(1, 2, NaN), trim = 0.5); mean(c(1, NA), trim = 0.1); mean(c(1, NA, 3), trim = 0.2, na.rm = TRUE); mean(numeric(0), trim = 0.1)
mean(c(5, 1, Inf), trim = 0.4); mean(c(5, 1, -Inf, Inf), trim = 0.1); mean(c(3, 1, 2, 10), trim = 0.6)
#-- mean-special
mean(c(1, Inf)); mean(c(-Inf, 1, 2)); mean(c(Inf, -Inf)); mean(c(Inf, -Inf, NA)); mean(rep(1e308, 4))
#-- min-max-mixed-character
max(9, 10, "5"); max("5", 9, 10); max(c(9, 10), "5"); max("5", c(9, 10)); min(c(1e-20, 1), "5"); min(c(1.5, 2.25), "2"); max(pi, ""); max(1e5, ""); max(1234567.1, ""); max(TRUE, "")
max(-0, ""); max(Inf, ""); max(NaN, "a"); min(NaN, "a"); max("a", c(NaN, 1)); max(NA, "a"); max("a", c(NA, 1)); max(1, NA, "a", na.rm = TRUE); max(c("b", "B", "a")); min(c("b", "B", "a"))
#-- min-max-character-empty
max(character(0))
min(NA_character_, na.rm = TRUE)
#-- min-max-signed-zero
1/max(-0, 0); 1/max(0, -0); 1/min(0, -0); 1/min(-0, 0); 1/max(c(-0, 0)); max(NaN, 1L, NA); typeof(min(NA_integer_, NaN))
