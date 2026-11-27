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
