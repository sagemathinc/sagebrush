#-- dbl-third
1/3
#-- dbl-two-thirds
2/3
#-- dbl-1e5
1e5
#-- dbl-100000-plus
100000 + 0.5
#-- dbl-123456789
123456789
#-- dbl-1e15
1e15
#-- dbl-1e16
1e16
#-- dbl-1e-5
1e-5
#-- dbl-1e-4
0.0001
#-- dbl-0.1-0.2
0.1 + 0.2
#-- dbl-neg
-1.5
#-- dbl-mixed
c(1, 1e10)
#-- dbl-mixed-small
c(0.00001, 1000)
#-- dbl-mixed-neg
c(-1, 2.25, 100)
#-- dbl-na
c(1.5, NA, 3)
#-- dbl-nan-inf
c(NaN, Inf, -Inf, 1)
#-- dbl-pi-big
pi * 1e6
#-- dbl-tiny
1e-300
#-- dbl-seven-digits
1234567.1
#-- dbl-eight-digits
12345678.1
#-- dbl-round-up
0.99999999
#-- dbl-many
c(1.123456789, 2.1, 3)
#-- dbl-wrap
c(1.5, 2.25, 3.125, 4.0625, 5.03125, 6.015625, 7.0078125, 8.00390625, 9.001953125, 10.0009765625, 11.5, 12.25, 13.125)
#-- dbl-neg-zero
-0
#-- opt-digits-3
options(digits = 3); c(1/3, 123.456)
#-- opt-digits-15
options(digits = 15); 1/3
#-- opt-scipen-1-fixed
options(scipen = 1); 1e5
#-- opt-scipen-1-sci
options(scipen = 1); 1e6
#-- opt-scipen-minus-1
options(scipen = -1); 1e4
#-- opt-scipen-minus-1-small
options(scipen = -1); 100
#-- opt-scipen-big
options(scipen = 999); 1e100
#-- opt-scipen-exp-3
options(scipen = 999); c(1e-100, 1)
#-- int-wrap
1:30
#-- int-wrap-100
1:100
#-- int-wrap-1000
990:1010
#-- int-neg
-5:5
#-- int-na
c(1L, NA, 3L)
#-- int-big
100000L
#-- lgl
c(TRUE, NA, FALSE)
#-- lgl-wrap
c(TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, TRUE)
#-- empty-dbl
numeric(0)
#-- empty-int
integer(0)
#-- empty-chr
character(0)
#-- empty-lgl
logical(0)
#-- empty-cplx
complex(0)
#-- null
NULL
#-- chr
c("a", NA, "b")
#-- chr-tab
"tab\t"
#-- chr-quote
"say \"hi\""
#-- chr-backslash
"back\\slash"
#-- chr-latin
"\u00e9t\u00e9"
#-- chr-cjk
c("\u65e5\u672c", "ab")
#-- chr-zero-width
"a\u200bb"
#-- chr-unassigned-d7ff
"\uD7FF"
#-- chr-unassigned-0378
"\u0378"
#-- chr-del
"\x7f"
#-- chr-c1
"\u0085"
#-- chr-emoji
"\U0001F600"
#-- chr-combining
"e\u0301"
#-- chr-wrap
c("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi")
#-- chr-na-wide
c(NA, "a")
#-- named-dbl
c(a = 1, bb = 2, ccc = 3)
#-- named-na
c(alpha = 1.5, b = NA)
#-- named-long
c(first_value = 1, second_value = 22, third_value = 333, fourth_value = 4444, fifth_value = 55555, sixth = 6)
#-- named-chr
c(a = "x", b = "yy")
#-- named-lgl
c(a = TRUE, b = FALSE)
#-- named-partial
c(a = 1, 2, c = 3)
#-- named-wide-value
c(a = 123456789, b = 1)
#-- named-na-name
x <- c(1, 2); names(x)
#-- cplx
1+2i
#-- cplx-vec
c(1+2i, -1i, 3)
#-- cplx-na
c(1+2i, NA)
#-- cplx-big
1e10+1i
#-- cplx-frac
1/3+2/3i
#-- cplx-arith
(1+2i) * (3-1i)
#-- cplx-div
(1+2i) / (3-1i)
#-- cplx-eq
1+2i == 1+2i
#-- cplx-lt
1+2i < 2+1i
#-- cplx-div-zero
(1+2i)/0
#-- cplx-zero-div-zero
0i/0
#-- cplx-mod
(1+2i) %% 2
#-- cplx-intdiv
(1+2i) %/% 2
#-- cplx-pow-int
(1+2i)^2
#-- cplx-pow-i
2^(1i)
#-- cplx-i-squared
1i^2
#-- cplx-neg
-(1+2i)
#-- cplx-plus-lgl
(1+2i) + TRUE
#-- cplx-ne
(1+2i) != 1
#-- cplx-eq-recycle
c(1+2i) == c(1+2i, 2)
#-- cplx-nan
complex(real = NaN, imaginary = 1)
#-- cplx-inf
complex(real = Inf, imaginary = -Inf)
#-- cplx-deparse-unary
-(2i) + 'a'
#-- names-arith-scalar
c(a = 1, b = 2) + 1
#-- names-arith-second
1 + c(a = 1)
#-- names-arith-first-wins
c(a = 1, b = 2) + c(x = 1, y = 2)
#-- names-arith-longer
c(a = 1) + c(x = 1, y = 2)
#-- names-arith-equal-one
c(a = 1) + c(b = 2)
#-- names-unary
-c(a = 1)
#-- names-not
!c(a = TRUE)
#-- names-compare
c(a = 1, b = 2) > 1
#-- names-int
c(a = 1L) + 1L
