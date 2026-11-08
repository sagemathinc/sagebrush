#-- tok-right-super
1 ->> ->> x
#-- tok-lt
1 < < 2
#-- tok-ge
1 >= >= 2
#-- tok-or
1 | | 2
#-- tok-ns-int
base ::: ::: sum
#-- tok-placeholder-after
1 _
#-- tok-placeholder-alone
_
#-- tok-placeholder-in-call
f <- function(x) x; f(_)
#-- tok-placeholder-pipe-extract
list(a = 5) |> _$a
#-- tok-placeholder-twice
3 |> rep(x = _, times = _)
#-- tok-lambda-only
\
#-- tok-colon-eq
x := 1
#-- tok-int-decimal-zero
1.0L
#-- tok-int-negative-exp
1e-3L
#-- tok-hex-big-L
0xFFFFFFFFL
#-- tok-hex-float-L
0x1p2L
#-- tok-hex-frac
0x1.8p1
#-- tok-hex-no-digits
0x
#-- tok-exp-no-digits
1e
#-- tok-double-dot-number
1.2.3
#-- tok-imaginary-int
3Li
#-- tok-string-x-no-hex
"\xg"
#-- tok-string-nul
"a\0b"
#-- tok-string-u-too-big
"\U{110000}"
#-- tok-string-escape-space
cat("a\ b\n")
#-- tok-string-escape-newline
cat("a\
b\n")
#-- tok-string-backtick-escape
cat("\`x\`\n")
#-- tok-string-bell-etc
nchar("\a\b\f\v\r")
#-- tok-raw-unterminated
r"(abc"
#-- tok-raw-bad-open
r"abc"
#-- tok-backtick-empty
`` <- 1
#-- tok-backtick-escape
`a\`b` <- 1; `a\`b`
#-- tok-backtick-unterminated
`abc
#-- tok-context-leading-space
   x y
#-- tok-context-after-semicolon
1;   x y
#-- tok-context-three-lines
{
  1
  a b
}
#-- tok-context-comment
{ # start
  a b
}
#-- tok-formals-dup
f <- function(x, x) 1
#-- tok-formals-number
f <- function(1) 1
#-- tok-formals-dots-default
f <- function(... = 1) 1
#-- tok-for-number-var
for (1 in 1:2) 1
#-- tok-for-missing-in
for (i 1:2) 1
#-- tok-if-missing-paren
if TRUE 1
#-- tok-function-no-paren
function x x
#-- tok-call-unclosed-bracket
x <- 1:3; x[1
#-- tok-bb-close-single
x <- list(1); x[[1]
#-- tok-unmatched-close-bb
x <- list(1); x[1]]
#-- tok-eq-in-call-chain
c(a = b = 1)
#-- tok-assign-in-for-cond
for (i in x <- 1:2) i
#-- tok-while-eq
while (i = 1) 1
#-- tok-paren-eq
(z = 5)
#-- tok-function-body-eq
f <- function() g = 2; f()
#-- tok-if-body-eq
if (TRUE) w = 3; w
#-- tok-arrow-in-arg
f <- function(x) x; f(x -> y); y
#-- tok-empty-program
#-- tok-only-semicolon-newline
1
;
#-- tok-trailing-semicolon
1;
#-- tok-leading-semicolon
;1
#-- tok-cr
x <- 1
