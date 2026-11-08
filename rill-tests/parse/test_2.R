#-- tok-left-assign
x <- <- 1
#-- tok-super-assign
x <<- <<- 1
#-- tok-right-assign
1 -> -> x
#-- tok-eq-assign
x = = 1
#-- tok-special
1 %in% %in% 2
#-- tok-pipe
1 |> |> f()
#-- tok-null
NULL NULL
#-- tok-true
TRUE TRUE
#-- tok-na
NA NA
#-- tok-inf
Inf Inf
#-- tok-function
f function
#-- tok-if
1 if
#-- tok-for
1 for
#-- tok-while
1 while
#-- tok-repeat
1 repeat
#-- tok-break
1 break
#-- tok-in
in
#-- tok-and
1 & & 2
#-- tok-and2
1 && && 2
#-- tok-or2
1 || || 2
#-- tok-gt
1 > > 2
#-- tok-le
1 <= <= 2
#-- tok-eq
1 == == 2
#-- tok-ne
1 != != 2
#-- tok-star
1 * * 2
#-- tok-slash
1 / / 2
#-- tok-caret
1 ^ ^ 2
#-- tok-colon
1 : : 2
#-- tok-tilde-binary
x ~ ~ ~
#-- tok-dollar
x $ $ y
#-- tok-at
x @ @ y
#-- tok-ns
base :: :: sum
#-- tok-lbracket
[1]
#-- tok-lbb
[[1]]
#-- tok-rbracket
1 ]
#-- tok-lbrace-after
1 {
#-- tok-comma
1 , 2
#-- tok-semicolon-only
;
#-- tok-question
1 ? ? 2
#-- tok-backslash
1 \
#-- tok-bad-char
1 # ok
2 @@ 3
#-- tok-input
x <- 1 $$ 2
#-- tok-unicode-ident
café <- 2; café + 1
#-- tok-dot-ident
.x <- 1; ..y <- 2; .x + ..y
#-- tok-underscore-start
_x <- 1
#-- tok-digit-ident
2x <- 1
#-- tok-context-later-line
x <- 1
y <- 2 3
#-- tok-context-indented
{
    a b
}
#-- tok-context-long
aaaaaaaaaa <- bbbbbbbbbb + cccccccccc * dddddddddd - eeeeeeeeee / ffffffffff gggg
#-- tok-context-multiline-expr
f(1,
  2 3)
#-- tok-double-semicolon
1;; 2
#-- tok-else-in-function
f <- function() {
  if (TRUE) 1
  else 2
}
f()
#-- tok-function-missing-body
function(x)
#-- tok-number-forms
c(1e-2, 1E2, 0xFF, 0XAb, 1e+2, 100000, 1e5, 123456789012)
#-- tok-int-forms
c(1L, 0x7FL, 1e2L)
#-- tok-string-in-formals
f <- function("a") 1
#-- tok-call-on-number
1(2)
#-- tok-empty-parens
()
#-- tok-empty-braces
{}
#-- tok-nested-function-default
f <- function(x = function(y) y + 1) x(2); f()
#-- tok-arg-name-string
f <- function(a) a; f("a" = 3)
#-- tok-arg-name-backtick
f <- function(`a b`) `a b`; f(`a b` = 4)
#-- tok-arg-name-null
c(NULL = 1)
#-- tok-unary-not-low
!TRUE & FALSE
#-- tok-tilde-low
quote(a ~ b || c)
#-- tok-question-low
quote(a <- b ? c)
#-- tok-assign-in-arg
f <- function(x) x; f(y <- 3); y
#-- tok-eq-in-braces
{ z = 4 }; z
#-- tok-pipe-precedence
quote(a + b |> f())
#-- tok-pipe-lambda
4 |> (\(v) v * 10)()
#-- tok-colon-unary
quote(-a:b)
#-- tok-pow-unary
quote(-a^b)
#-- tok-dollar-call
l <- list(f = function() 9); l$f()
#-- tok-bracket-chain
m <- list(list(1, 2), list(3, 4)); m[[2]][[1]]
#-- tok-if-else-chain
x <- 5; if (x < 3) "a" else if (x < 6) "b" else "c"
#-- tok-repeat-break
i <- 0; repeat { i <- i + 1; if (i >= 3) break }; i
#-- tok-while-next
i <- 0; s <- 0; while (i < 5) { i <- i + 1; if (i == 2) next; s <- s + i }; s
#-- tok-for-in-paren-newline
for (k in
     1:2) print(k)
