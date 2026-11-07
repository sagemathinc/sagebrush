# Rill corpus: functions and evaluation. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- fun-1
sq <- function(x) x^2
sq(1:4)
#-- fun-2
f <- function(x, y = 2) x + y
f(1); f(1, 10); f(y = 5, x = 1)
#-- fun-3
f <- function(...) sum(...)
f(1, 2, 3)
#-- fun-4
f <- function(x) { x[1] <- 99; x }
v <- c(1, 2)
f(v); v
#-- fun-5
make_counter <- function() { i <- 0; function() { i <<- i + 1; i } }
cnt <- make_counter()
cnt(); cnt()
#-- fun-6
f <- function(a, b) { if (missing(b)) "no b" else b }
f(1)
#-- fun-7
f <- function(x) { stopifnot(is.numeric(x)); invisible(x * 2) }
f(3)
y <- f(3)
y
#-- fun-8
f <- function(x) substitute(x)
f(a + b)
#-- fun-9
(function(x, y) x * y)(3, 4)
#-- fun-10
sapply(1:3, \(k) k + 1)
#-- fun-11
c(1, 4, 9) |> sqrt()
#-- fun-12
f <- function(x) { return(x + 1); 0 }
f(1)
#-- fun-13
g <- function(n = 5) seq_len(n)
g()
#-- fun-14
tryCatch(stop("boom"), error = function(e) conditionMessage(e))
#-- fun-15
do.call(paste, list("a", "b", sep = ""))
