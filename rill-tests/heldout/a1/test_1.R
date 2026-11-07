# Rill held-out corpus for phase A1 (core language and printing), design/rill.md §7.4.
# Written before any A1 code; frozen by SHA256SUMS; scored once at A1's end and never edited.
#-- clo-1
make_adder <- function(n) function(x) x + n
add3 <- make_adder(3)
add3(10); add3(1:3)
#-- clo-2
counter <- local({ k <- 0; function() { k <<- k + 1; k } })
counter(); counter(); counter()
#-- clo-3
x <- 1
f <- function() { x <- 2; g <- function() x; g() }
f(); x
#-- clo-4
f <- function() { y <- 10; h <- function() y <<- y + 1; h(); y }
f()
#-- lazy-1
f <- function(a, b) { if (a > 0) "pos" else b }
f(1, stop("never evaluated"))
#-- lazy-2
f <- function(x, y = x * 2) { x <- 100; y }
f(1)
#-- lazy-3
f <- function(x) { force(x); function() x }
g <- f(5); g()
#-- lazy-4
f <- function(a, b) c(missing(a), missing(b))
f(); f(1); f(b = 2)
#-- lazy-5
f <- function(n = 3) { n <- n + 1; n }
f(); f(10)
#-- dots-1
f <- function(...) length(list(...))
f(); f(1, 2, 3); f(a = 1, b = NULL)
#-- dots-2
f <- function(...) names(list(...))
f(a = 1, 2, b = 3)
#-- dots-3
g <- function(x, ...) paste(x, ...)
g("a", "b", sep = "-")
#-- dots-4
f <- function(first, ...) { rest <- c(...); sum(rest) / first }
f(2, 4, 6, 8)
#-- dots-5
f <- function(...) ..2
f("a", "b", "c")
#-- match-1
f <- function(alpha, beta = 2) alpha * beta
f(be = 3, al = 4)
#-- match-2
f <- function(x, value) x + value
f(value = 1, 10)
#-- repl-1
`second<-` <- function(x, value) { x[2] <- value; x }
v <- c(1, 2, 3)
second(v) <- 99
v
#-- repl-2
l <- list(a = list(b = 1))
l$a$b <- 5
l$a$c <- "new"
str(l)
#-- repl-3
m <- matrix(0, 2, 2)
m[1, ] <- c(7, 8)
dimnames(m) <- list(c("r1", "r2"), c("c1", "c2"))
m["r2", "c2"] <- -1
m
#-- repl-4
x <- 1:5
names(x)[3] <- "three"
x
#-- repl-5
x <- c(a = 1, b = 2)
x[["c"]] <- 3
x
#-- env-1
e <- new.env()
assign("v", 42, envir = e)
get("v", envir = e); exists("v", envir = e); exists("nope", envir = e)
#-- env-2
e <- new.env()
local({ z <- 7 }, envir = e)
ls(e)
#-- env-3
f <- function() environment()
e <- f()
class(e); is.environment(e)
#-- env-4
x <- "global"
f <- function() { x <- "local"; get("x", envir = parent.frame()) }
f()
#-- s3-1
area <- function(s, ...) UseMethod("area")
area.square <- function(s, ...) s$side^2
area.default <- function(s, ...) NA
sq <- structure(list(side = 3), class = "square")
area(sq); area(5)
#-- s3-2
print.money <- function(x, ...) { cat("$", format(unclass(x), nsmall = 2), "\n"); invisible(x) }
m <- structure(12.5, class = "money")
m
print(m)
#-- s3-3
speak <- function(x) UseMethod("speak")
speak.animal <- function(x) cat("some sound\n")
speak.dog <- function(x) { cat("woof\n"); NextMethod() }
d <- structure(list(), class = c("dog", "animal"))
speak(d)
#-- s3-4
format.temp <- function(x, ...) paste0(unclass(x), "C")
print.temp <- function(x, ...) print(format(x), quote = FALSE)
t1 <- structure(21.5, class = "temp")
t1
#-- s3-5
x <- structure(1:3, class = "myvec")
inherits(x, "myvec"); inherits(x, "other"); class(unclass(x))
#-- s3-6
length.stack <- function(x) length(x$items)
s <- structure(list(items = list(1, 2, 3)), class = "stack")
length(s)
#-- cond-1
r <- tryCatch(stop("oops"), error = function(e) paste("caught:", conditionMessage(e)))
r
#-- cond-2
r <- tryCatch(warning("careful"), warning = function(w) conditionMessage(w))
r
#-- cond-3
tryCatch({ cat("body\n"); 1 }, finally = cat("finally\n"))
#-- cond-4
f <- function() { warning("inner warning"); "value" }
r <- withCallingHandlers(f(), warning = function(w) { cat("handled:", conditionMessage(w), "\n"); invokeRestart("muffleWarning") })
r
#-- cond-5
res <- try(log(-1), silent = TRUE)
res
#-- cond-6
res <- try(stop("bad thing"), silent = TRUE)
class(res); cat(res)
#-- cond-7
f <- function(x) { if (!is.numeric(x)) stop("need a number: ", class(x)); x }
tryCatch(f("a"), error = function(e) conditionMessage(e))
#-- cond-8
e <- simpleError("custom message")
tryCatch(stop(e), error = function(err) class(err))
#-- cond-9
f <- function() message("note to user")
suppressMessages(f()); cat("done\n")
#-- cond-10
f <- function() { warning("w1"); warning("w2"); 3 }
x <- f()
x
#-- cond-11
f <- function(x) sqrt(x)
f(-4)
#-- cond-12
stop("top level failure")
#-- onexit-1
f <- function() { on.exit(cat("bye\n")); cat("hello\n"); invisible(1) }
f()
#-- onexit-2
f <- function() { on.exit(cat("first\n")); on.exit(cat("second\n"), add = TRUE); NULL }
invisible(f())
#-- onexit-3
f <- function() { on.exit(cat("a\n")); on.exit(cat("b\n"), add = TRUE, after = FALSE); 0 }
invisible(f())
#-- onexit-4
f <- function() { on.exit(cat("cleanup\n")); stop("fail") }
tryCatch(f(), error = function(e) cat("error:", conditionMessage(e), "\n"))
#-- flow-1
for (i in seq_len(0)) print(i)
cat("none\n")
#-- flow-2
i <- 0
repeat { i <- i + 2; if (i > 7) break }
i
#-- flow-3
out <- character()
for (w in c("a", "b", "c", "d")) { if (w == "b") next; out <- c(out, w) }
out
#-- flow-4
f <- function(x) switch(x, "a" = , "b" = "a or b", "c" = "c", "other")
f("a"); f("b"); f("c"); f("z")
#-- flow-5
switch(2, "one", "two", "three")
#-- flow-6
x <- if (FALSE) 1
is.null(x)
#-- flow-7
n <- 0
while (TRUE) { n <- n + 1; if (n >= 3) break }
n
#-- lang-1
quote(x + y * 2)
#-- lang-2
e <- quote(a * (b + 1))
class(e); e[[1]]; as.list(e)
#-- lang-3
f <- function(x) deparse(substitute(x))
f(mean(1:10)); f(z)
#-- lang-4
a <- 5
bquote(x + .(a))
#-- lang-5
e <- expression(1 + 2, 3 * 4)
sapply(e, eval)
#-- lang-6
f <- function(x, y) match.call()
f(1, y = 2)
#-- lang-7
eval(parse(text = "1:3 * 2"))
#-- lang-8
g <- function() sys.call()
g()
#-- lang-9
fib <- function(n) if (n < 2) n else Recall(n - 1) + Recall(n - 2)
fib(12)
#-- lang-10
do.call("sum", list(1, 2, 3))
#-- pr-1
c(1.5, NA, -Inf, NaN, 1e-20)
#-- pr-2
c(123456789, 0.000123)
#-- pr-3
-0.0; 1/-Inf
#-- pr-4
x <- seq(0.05, 1, by = 0.05)
x
#-- pr-5
setNames(1:26, letters)
#-- pr-6
c(first = "apple", second = "banana", third = NA)
#-- pr-7
list(1, "two", list(3, list(4)), NULL)
#-- pr-8
list(a = NULL, b = list(), c = character(0))
#-- pr-9
factor(c("small", "large", "medium", "small"), levels = c("small", "medium", "large"), ordered = TRUE)
#-- pr-10
matrix(c(1.25, -3, 1000, 0.5), 2)
#-- pr-11
matrix(c("a", "bb", "ccc", NA), 2)
#-- pr-12
data.frame(n = c(1.5, NA, 3), s = c("x", NA, "z"), b = c(TRUE, NA, FALSE))
#-- pr-13
array(1:12, dim = c(2, 3, 2))
#-- pr-14
.Machine$integer.max + 1L
#-- pr-15
2147483647L * 2L
#-- pr-16
print(pi, digits = 3); print(c(1.123456, 2.1), digits = 2)
#-- pr-17
format(c(1, 10, 100)); format(3.14159, digits = 3); format(TRUE, width = 6)
#-- pr-18
noquote(c("a", "b"))
#-- pr-19
invisible(7)
(invisible(7))
#-- pr-20
x <- c(10.123, 200.5, 3000)
names(x) <- c("short", "a much longer name", "mid")
x
#-- vap-1
vapply(1:3, function(i) i * 2, numeric(1))
#-- vap-2
vapply(list(1:2, 3:4), range, numeric(2))
#-- vap-3
vapply(1:2, function(i) letters[i], "")
#-- vap-4
vapply(1:3, function(i) 1:i, numeric(1))
#-- red-1
Reduce(function(a, b) paste0(a, b), c("x", "y", "z"), accumulate = TRUE)
#-- red-2
Reduce(`+`, 1:4, accumulate = TRUE, right = TRUE)
#-- red-3
Reduce(function(a, b) a * b, 1:5, 100)
#-- map-1
mapply(function(a, b) a^b, 1:4, 2)
#-- map-2
mapply(function(x, times) paste(rep(x, times), collapse = ""), c("a", "b"), c(3, 1))
