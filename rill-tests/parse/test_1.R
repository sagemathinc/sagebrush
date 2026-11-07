#-- prec-unary-pow
-2^2
#-- prec-unary-colon
-1:3
#-- prec-pow-right
2^3^2
#-- prec-pow-neg
2^-1
#-- prec-colon-times
1:3*2
#-- prec-plus-colon
1+1:3
#-- prec-not-cmp
!1 == 2
#-- prec-and-or
TRUE || FALSE && FALSE
#-- prec-mod-times
7 %% 3 * 2
#-- prec-intdiv
7 %/% 2 + 1
#-- prec-in
2 %in% 1:3 == TRUE
#-- prec-unary-minus-mod
-7 %% 3
#-- assign-right
3 -> x; x
#-- assign-right-super
4 ->> y; y
#-- assign-chain
a <- b <- 4; a + b
#-- assign-eq
x = 5; x
#-- assign-eq-chain
x = y <- 6; x * y
#-- num-hex
0x1F
#-- num-hex-int
0x10L + 1L
#-- num-exp
1e3
#-- num-exp-neg
2.5e-3
#-- num-hexfloat
0x1p4
#-- num-dot
.5 + 1.
#-- num-int-max
2147483647L
#-- num-L-decimal
1.5L
#-- num-L-big
3000000000L
#-- num-L-exp
1e3L
#-- num-imaginary
2i
#-- str-escapes
cat("a\tb\\c\"d'e\n")
#-- str-single-quotes
cat('it\'s "fine"\n')
#-- str-unicode
cat("\u00e9 \U0001F600 \x41 \101\n")
#-- str-unicode-braces
cat("\u{e9}\U{1F600}\n")
#-- str-raw
cat(r"(C:\path\n)", "\n")
#-- str-raw-dashes
cat(r"-[a)"]-", "\n")
#-- str-raw-braces
cat(R"{x}", "\n")
#-- str-bad-escape
"\q"
#-- str-newline-inside
cat("a
b\n")
#-- str-hash-inside
x <- "a # not a comment"; x
#-- backtick-name
`my var` <- 2; `my var` * 3
#-- backtick-op
`+`(2, 3)
#-- semicolons
1; 2
#-- newline-in-paren
(1 +
 2)
#-- newline-after-op
1 +
  2
#-- newline-in-bracket
x <- c(10, 20, 30)
x[
  2
]
#-- if-else-in-brace
{
  if (FALSE) 1
  else 2
}
#-- if-else-in-paren
(if (FALSE) 1
 else 3)
#-- err-else-top
if (TRUE) 1
else 2
#-- err-symbol
x y
#-- err-number
1 2
#-- err-string
"a" "b"
#-- err-close-paren
1 + )
#-- err-close-brace
}
#-- err-comma
f(1,,2
#-- err-incomplete
1 +
#-- err-incomplete-call
sum(1,
#-- err-unterminated-string
"abc
#-- err-assign-target
1 <- 2
#-- err-equals-in-if
if (x = 1) 2
#-- pipe
c(1, 4, 9) |> sqrt() |> sum()
#-- pipe-placeholder
3 |> rep(x = "a", times = _)
#-- pipe-err-nocall
1 |> sqrt
#-- pipe-err-placeholder-unnamed
3 |> rep("a", _)
#-- lambda
(\(x) x + 1)(2)
#-- function-newline-body
f <- function(x)
  x * 2
f(4)
#-- dots-index
f <- function(...) ..2; f(5, 6, 7)
#-- ns-double-colon
base::sum(1:4)
#-- ns-triple-colon
base:::sum(2, 3)
#-- formula-print
y ~ x + z
#-- formula-one-sided
~ x
#-- unary-chain
- - 3
#-- not-not
!!TRUE
#-- dollar-string
l <- list(a = 1, `b c` = 2); l$"b c" + l$a
#-- bracket-missing
m <- matrix(1:6, 2); m[, 2]
#-- arg-empty-name
f <- function(a, b) missing(b); f(1, )
#-- keyword-as-name-err
TRUE <- 1
#-- keyword-in-backticks
`if`(TRUE, "y", "n")
#-- comment-only
# nothing here
#-- trailing-comment
1 + 1 # two
#-- quote-deparse
quote(-(1 + 2) * x[[i]]$y)
#-- quote-function
quote(function(x, y = 2) x + y)
#-- quote-if
quote(if (a) b else c)
#-- quote-assign-right
quote(1 -> x)
