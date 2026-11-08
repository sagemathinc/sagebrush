#-- int-plus
1L + 2L
#-- int-double
1L + 0.5
#-- lgl-arith
TRUE + TRUE
#-- int-div
5L / 2L
#-- int-pow
2L ^ 3L
#-- int-mod
-7L %% 3L
#-- int-intdiv
-7L %/% 2L
#-- dbl-mod-neg
5 %% -3
#-- dbl-mod-frac
5.5 %% 2
#-- intdiv-zero-int
5L %/% 0L
#-- mod-zero-int
5L %% 0L
#-- intdiv-zero-dbl
5 %/% 0
#-- mod-zero-dbl
5 %% 0
#-- div-zero
c(1 / 0, -1 / 0, 0 / 0)
#-- int-overflow
2147483647L + 1L
#-- int-overflow-times
100000L * 100000L
#-- int-overflow-unary
-(-2147483647L)
#-- pow-big
2^1024
#-- pow-neg-frac
(-8)^(1/3)
#-- pow-na
c(1^NA, NA^0, NA_integer_^0L)
#-- na-arith
c(NA + 1, NA_integer_ + 1L, NaN + 1)
#-- na-int-type
NA_integer_ * 2L
#-- recycle
1:6 + c(10, 20)
#-- recycle-warn
1:3 + 1:2
#-- recycle-zero
integer(0) + 1
#-- null-arith
NULL + 1
#-- char-arith
1 + "a"
#-- char-unary
-"a"
#-- unary-lgl
-TRUE
#-- unary-plus-chr
+"a"
#-- cmp-num
c(1, 2, 3) > 2
#-- cmp-chr
c("10" < "9", "a" < "B", "abc" == "abc")
#-- cmp-mixed
"1" == 1
#-- cmp-na
c(NA > 1, NA == NA)
#-- cmp-recycle-warn
1:3 == 1:2
#-- not-num
!c(0, 1, 2)
#-- not-chr
!"a"
#-- and-or-vec
c(TRUE, FALSE, NA) & c(TRUE, TRUE, TRUE)
#-- or-na
c(NA | TRUE, NA | FALSE, NA & FALSE, NA & TRUE)
#-- and-chr
"a" & TRUE
#-- and-num
c(0, 2) & c(1, 1)
#-- andand-scalar
c(TRUE && FALSE, FALSE || TRUE, NA && FALSE, NA || TRUE)
#-- andand-na
NA && TRUE
#-- andand-length2
c(TRUE, FALSE) && TRUE
#-- andand-chr
"a" && TRUE
#-- andand-num
2 && 0
#-- oror-null
NULL || TRUE
#-- colon-int
1:5
#-- colon-down
5:1
#-- colon-neg
-2:2
#-- colon-dbl
1.5:4
#-- colon-chr
"1":"3"
#-- colon-na
1:NA
#-- colon-length2
c(1, 2):3
#-- colon-big-int
2147483646:2147483648
#-- colon-chr-bad
"a":"c"
#-- c-types
c(1L, 2.5, TRUE)
#-- c-chr
c(1, "a", TRUE)
#-- c-null
c(NULL, 1, NULL)
#-- c-empty
c()
#-- c-lgl
c(TRUE, NA, FALSE)
#-- c-nested
c(c(1, 2), c(3, c(4, 5)))
#-- assign-print
x <- 3; x
#-- assign-invisible
x <- 3
#-- assign-paren
(x <- 4)
#-- assign-super
x <<- 7; x
#-- assign-string-target
"y" <- 8; y
#-- assign-chain-value
(a <- b <- 9)
#-- object-not-found
zzz
#-- object-not-found-in-arith
zzz + 1
#-- fn-not-found
foo(1)
#-- print-call
print(1:3)
#-- print-returns
x <- print(5); x
#-- invisible
invisible(5)
#-- invisible-paren
(invisible(6))
#-- quote-sym
quote(x)
#-- quote-call
quote(f(x, y = 2))
#-- cat-basic
cat(1, "a", TRUE, "\n")
#-- cat-sep
cat(1:3, sep = ", ")
#-- cat-num-format
cat(1/3, 1e6, 123456789, 1e-20, 100000, "\n")
#-- cat-na
cat(NA, NA_character_, NULL, "\n")
#-- print-wide
1:40
#-- print-doubles
c(1.5, 2, 3.25)
#-- print-sci
c(1e-10, 1)
#-- print-big
1e15
#-- print-bigger
1e16
#-- print-small
0.0001
#-- print-smaller
0.00001
#-- print-digits7
pi * 1e5
#-- print-chr-escape
"a\"b\\c\n"
#-- print-chr-na
c("a", NA)
#-- print-neg-zero
-0
#-- print-inf-mix
c(-Inf, 1, NaN, NA)
#-- print-int-na
c(1L, NA)
#-- print-lgl
c(TRUE, NA)
#-- print-long-chr
c("alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu")
#-- braces-value
{ 1; 2 }
#-- braces-empty
{}
#-- braces-invisible
{ x <- 1 }
#-- semicolon-statements
x <- 2; y <- 3; x * y
#-- nested-arith
((1 + 2) * (3 - 4)) / 5
#-- unary-minus-int-type
-1L
#-- int-print-width
c(1L, 100L, -5L)
