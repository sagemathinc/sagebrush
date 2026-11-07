## Rill spike corpus: intro-stats R. Cases are separated by lines "#--".
## Each case runs in a fresh R session (R 4.5.3, --vanilla); stdout is compared byte for byte.
#-- arith-1
1 + 2
#-- arith-2
2^10
#-- arith-3
-2^2
#-- arith-4
7 %/% 2; 7 %% 2; -7 %/% 2; -7 %% 2
#-- arith-5
5 / 2
#-- arith-6
1/3
#-- arith-7
22/7
#-- arith-8
1e6
#-- arith-9
100000
#-- arith-10
123456789
#-- arith-11
1e-5
#-- arith-12
0.1 + 0.2
#-- arith-13
1/0; -1/0; 0/0
#-- arith-14
sqrt(2)
#-- arith-15
exp(1)
#-- arith-16
pi * 1e10
#-- arith-17
.Machine$integer.max
#-- arith-18
5L / 2L
#-- arith-19
c(1.5, 2, 3.25)
#-- arith-20
c(0.001, 1000)
#-- arith-21
c(1e-10, 1)
#-- arith-22
c(123456, 0.1)
#-- arith-23
x <- c(10.5, 3, NA, 7)
x * 2
#-- arith-24
round(3.14159, 2); signif(123456, 2); round(-2.5); round(0.5); round(1.5)
#-- arith-25
log(100); log10(1000); log(8, base = 2); log2(1024); log1p(0)
#-- arith-26
abs(-3:3)
#-- arith-27
floor(-2.5); ceiling(2.1); trunc(-2.7)
#-- vec-1
1:10
#-- vec-2
1:30
#-- vec-3
seq(0, 1, by = 0.1)
#-- vec-4
seq(1, 10, length.out = 4)
#-- vec-5
seq_len(5); seq_along(c("a", "b", "c"))
#-- vec-6
rep(1:3, times = 2); rep(1:3, each = 2); rep(c("x", "y"), times = c(2, 3))
#-- vec-7
x <- c(5, 3, 8, 1)
sort(x); order(x); rev(x); sort(x, decreasing = TRUE)
#-- vec-8
x <- c(a = 1, b = 2, c = 3)
x
#-- vec-9
x <- c(a = 1, b = 2, c = 3)
x["b"]; names(x)
#-- vec-10
x <- 1:10
x[x > 5]
#-- vec-11
x <- c(4, 8, 15, 16, 23, 42)
x[-1]; x[c(1, 3)]; x[length(x)]
#-- vec-12
x <- 1:5
x[8] <- 10L
x
#-- vec-13
which(c(FALSE, TRUE, TRUE, FALSE))
#-- vec-14
x <- c(3, 9, 2, 9)
which.max(x); which.min(x); range(x)
#-- vec-15
cumsum(1:10); cumprod(1:6)
#-- vec-16
x <- 101:150
x
#-- vec-17
c(1, "a", TRUE)
#-- vec-18
c(1, TRUE, FALSE)
#-- vec-19
length(NULL); c()
#-- vec-20
1:3 + 1:6
#-- vec-21
x <- c(1, 2, 3)
y <- x
y[1] <- 100
x; y
#-- vec-22
diff(c(1, 4, 9, 16))
#-- vec-23
unique(c(3, 1, 3, 2, 1)); duplicated(c(3, 1, 3, 2, 1))
#-- vec-24
x <- c(2.5, 1.25, 10)
x / 3
#-- vec-25
seq(-1, 1, 0.5)
#-- vec-26
any(c(1, 5) > 4); all(c(1, 5) > 4)
#-- vec-27
5 %in% c(1, 5, 9); match(c("b", "z"), c("a", "b"))
#-- vec-28
head(letters); tail(LETTERS, 3)
#-- vec-29
month.name[1:3]
#-- vec-30
x <- 1:12
x[x %% 2 == 0]
#-- na-1
x <- c(1, NA, 3)
sum(x); sum(x, na.rm = TRUE); mean(x, na.rm = TRUE)
#-- na-2
is.na(c(1, NA, NaN, 4))
#-- na-3
NA > 1; NA & FALSE; NA | TRUE
#-- na-4
c(NA, "a")
#-- na-5
x <- c(2, NA, 5)
x[!is.na(x)]
#-- na-6
mean(c(NA, 1))
#-- na-7
NA_integer_; NA_real_; NA_character_; NULL
#-- logic-1
TRUE && FALSE; TRUE || FALSE; !TRUE
#-- logic-2
c(TRUE, FALSE) & c(TRUE, TRUE)
#-- logic-3
xor(TRUE, FALSE); isTRUE(c(TRUE, TRUE))
#-- logic-4
sum(c(TRUE, TRUE, FALSE))
#-- str-1
paste("a", "b", sep = "-"); paste0("x", 1:3)
#-- str-2
paste(c("a", "b"), collapse = "+")
#-- str-3
nchar("hello"); toupper("abc"); tolower("ABC"); substr("abcdef", 2, 4)
#-- str-4
sprintf("%.2f", pi); sprintf("%5d|%-5s|", 42L, "ab"); sprintf("%e", 12345.6789)
#-- str-5
cat("Hello", "world\n")
#-- str-6
cat("x =", 3.14159, "\n")
#-- str-7
cat(1:5, sep = ", "); cat("\n")
#-- str-8
print("quoted")
#-- str-9
strsplit("a,b,c", ","); 
#-- str-10
x <- "Statistics"
rev(strsplit(x, "")[[1]])
#-- str-11
format(3.14159, nsmall = 2); format(42L, width = 6); format(TRUE)
#-- str-12
formatC(3.14159, digits = 3, format = "f"); formatC(5, width = 3, flag = "0")
#-- str-13
toupper(letters[1:5])
#-- str-14
cat(sep = "", "a", "b\n")
#-- str-15
cat(TRUE, NA, 1L, 2.5, "s\n")
#-- stats-1
x <- c(2, 4, 4, 4, 5, 5, 7, 9)
mean(x); median(x); var(x); sd(x)
#-- stats-2
x <- c(1, 2, 3, 4, 100)
summary(x)
#-- stats-3
quantile(1:10)
#-- stats-4
quantile(c(1.5, 2.5, 10, 7), probs = c(0.1, 0.9))
#-- stats-5
x <- c(1, 2, 3, 4, 5); y <- c(2.1, 3.9, 6.2, 7.8, 10.1)
cor(x, y)
#-- stats-6
min(3, 1, 2); max(c(4, 9), 7); prod(1:6); sum(1:100)
#-- stats-7
x <- c(10, 20, 30)
scale(x)[, 1]
#-- stats-8
IQR(c(1, 3, 5, 7, 9, 11)); mad(c(1, 2, 3, 4, 100))
#-- stats-9
tabulate(c(1, 2, 2, 5))
#-- stats-10
cumsum(c(0.1, 0.2, 0.3))
#-- stats-11
fivenum(c(1, 2, 3, 4, 5, 6))
#-- stats-12
choose(5, 2); factorial(5); gamma(0.5); beta(2, 3)
#-- stats-13
var(c(1, 2), c(3, 5)); cov(1:5, c(2, 4, 6, 8, 10))
#-- stats-14
weighted.mean(c(1, 2, 3), c(3, 2, 1))
#-- dist-1
dnorm(0); pnorm(1.96); qnorm(0.975)
#-- dist-2
pnorm(c(-1, 0, 1))
#-- dist-3
dbinom(3, size = 10, prob = 0.5); pbinom(3, 10, 0.5); qbinom(0.5, 10, 0.3)
#-- dist-4
dbinom(0:4, 4, 0.5)
#-- dist-5
dpois(2, lambda = 3); ppois(2, 3); qpois(0.9, 3)
#-- dist-6
pt(2.0, df = 10); qt(0.975, df = 5); dt(0, 3)
#-- dist-7
pchisq(3.84, df = 1); qchisq(0.95, 2)
#-- dist-8
pf(3, 2, 10); qf(0.95, 3, 20)
#-- dist-9
punif(0.3); dunif(0.5, 0, 2); qunif(0.25, 1, 3)
#-- dist-10
pexp(1, rate = 2); qexp(0.5); dexp(1)
#-- dist-11
pnorm(110, mean = 100, sd = 15); 1 - pnorm(2)
#-- dist-12
pnorm(1.5, lower.tail = FALSE)
#-- dist-13
qnorm(c(0.025, 0.5, 0.975))
#-- dist-14
pbinom(5, 20, 0.25, lower.tail = FALSE)
#-- dist-15
dnorm(1:3, mean = 2, sd = 0.5)
#-- dist-16
pgamma(2, shape = 2, rate = 1); pbeta(0.5, 2, 3)
#-- rng-1
set.seed(1)
runif(3)
#-- rng-2
set.seed(42)
rnorm(5)
#-- rng-3
set.seed(123)
sample(1:10)
#-- rng-4
set.seed(2024)
round(rnorm(3, mean = 10, sd = 2), 3)
#-- rng-5
set.seed(7)
sample(c("H", "T"), 10, replace = TRUE)
#-- rng-6
set.seed(1)
rbinom(5, 10, 0.5)
#-- rng-7
set.seed(10)
mean(runif(1000))
#-- fac-1
f <- factor(c("lo", "hi", "mid", "hi", "lo"))
f
#-- fac-2
f <- factor(c("lo", "hi", "mid", "hi"), levels = c("lo", "mid", "hi"))
f; levels(f); nlevels(f); as.integer(f)
#-- fac-3
table(c("a", "b", "a", "c", "a"))
#-- fac-4
f <- factor(c("x", "y", "x"))
summary(f)
#-- fac-5
x <- c(3, 1, 2, 3, 3)
table(x)
#-- fac-6
f <- factor(c("b", "a"), levels = c("a", "b", "c"))
table(f)
#-- fac-7
as.vector(factor(c("u", "v")))
#-- fac-8
factor(c(1, 2, 1), labels = c("one", "two"))
#-- fac-9
g <- factor(c("a", "b", "a", "b"))
tapply(c(1, 2, 3, 4), g, mean)
#-- fac-10
cut(c(1, 5, 9), breaks = c(0, 3, 6, 10))
#-- fac-11
droplevels(factor(c("a", "b"))[1])
#-- fac-12
f <- factor(c("a", "b", "a"))
levels(f)[2] <- "B"
f
#-- list-1
l <- list(a = 1, b = "two", c = c(3, 4))
l
#-- list-2
l <- list(1, "a")
l
#-- list-3
l <- list(x = 1:3, y = letters[1:2])
l$x; l[["y"]]; names(l)
#-- list-4
l <- list(a = 1)
l$b <- 2
str(l)
#-- list-5
unlist(list(a = 1, b = 2:3))
#-- list-6
length(list(1, 2, list(3, 4)))
#-- apply-1
sapply(1:5, function(i) i^2)
#-- apply-2
lapply(1:2, function(x) x * 10)
#-- apply-3
m <- matrix(1:6, nrow = 2)
apply(m, 1, sum); apply(m, 2, max)
#-- apply-4
sapply(c(a = 1, b = 2), function(v) v + 0.5)
#-- apply-5
vapply(list(1:3, 4:6), sum, numeric(1))
#-- apply-6
Map(function(a, b) a + b, 1:2, 3:4)
#-- apply-7
Reduce(`+`, 1:5, accumulate = TRUE); Filter(function(v) v > 2, 1:5)
#-- apply-8
sapply(list(a = 1:3, b = 4:6), mean)
#-- apply-9
mapply(rep, 1:3, 3:1)
#-- mat-1
m <- matrix(1:6, nrow = 2)
m
#-- mat-2
m <- matrix(1:4, 2)
t(m); dim(m); m %*% m
#-- mat-3
m <- matrix(c(2, 1, 1, 3), 2)
solve(m)
#-- mat-4
m <- matrix(c(2.5, 1, -1, 3), 2, dimnames = list(c("r1", "r2"), c("A", "B")))
m
#-- mat-5
cbind(1:3, 4:6); rbind(a = 1:2, b = 3:4)
#-- mat-6
m <- matrix(1:9, 3, byrow = TRUE)
m[2, ]; m[, 3]; m[2, 3]; diag(m)
#-- mat-7
det(matrix(c(1, 2, 3, 4), 2)); diag(2)
#-- mat-8
outer(1:3, 1:3)
#-- mat-9
rowSums(matrix(1:6, 2)); colMeans(matrix(1:6, 2))
#-- df-1
df <- data.frame(x = 1:3, y = c("a", "b", "c"))
df
#-- df-2
df <- data.frame(name = c("Ann", "Bob"), score = c(90.5, 85))
df$score; nrow(df); ncol(df); names(df)
#-- df-3
df <- data.frame(a = c(1.5, 2.25, 3), b = c(TRUE, FALSE, NA))
df
#-- df-4
df <- data.frame(g = c("x", "y", "x"), v = c(1, 2, 3))
df[df$v > 1, ]
#-- df-5
df <- data.frame(x = 1:5, y = c(2, 4, 6, 8, 10))
summary(df)
#-- df-6
df <- data.frame(x = 1:3)
df$z <- df$x^2
df
#-- df-7
df <- data.frame(x = 1:10)
head(df, 3)
#-- df-8
df <- data.frame(a = 1:2, b = 3:4)
str(df)
#-- df-9
df <- data.frame(x = c(3, 1, 2), y = c("c", "a", "b"))
df[order(df$x), ]
#-- df-10
df <- data.frame(g = c("a", "b", "a"), v = c(1, 5, 3))
aggregate(v ~ g, data = df, FUN = mean)
#-- df-11
head(mtcars)
#-- df-12
mean(mtcars$mpg); table(mtcars$cyl)
#-- df-13
df <- data.frame(x = 1:3, y = 4:6)
colMeans(df); sapply(df, class)
#-- df-14
df <- data.frame(x = c(1, 2), y = c("p", "q"), stringsAsFactors = TRUE)
levels(df$y); df[2, "x"]
#-- df-15
dim(iris); levels(iris$Species)
#-- df-16
with(mtcars, tapply(mpg, cyl, mean))
#-- df-17
subset(data.frame(a = 1:4, b = c(5, 6, 7, 8)), a > 2)
#-- df-18
df <- data.frame(x = c(-1.5, 22.25, 3))
df
#-- ctrl-1
for (i in 1:3) print(i)
#-- ctrl-2
x <- 5
if (x > 3) "big" else "small"
#-- ctrl-3
i <- 0
while (i < 3) { i <- i + 1 }
i
#-- ctrl-4
f <- function(n) if (n <= 1) 1 else n * f(n - 1)
f(10)
#-- ctrl-5
ifelse(c(1, 5, 10) > 4, "hi", "lo")
#-- ctrl-6
total <- 0
for (v in c(2, 4, 6)) total <- total + v
total
#-- ctrl-7
s <- 0
repeat { s <- s + 1; if (s >= 4) break }
s
#-- ctrl-8
for (i in 1:5) { if (i %% 2 == 0) next; cat(i, "") }; cat("\n")
#-- ctrl-9
switch("b", a = "first", b = "second", "other")
#-- ctrl-10
x <- 3
y <- if (x > 5) 1 else 0
y
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
#-- test-1
x <- c(5.1, 4.9, 6.2, 5.8, 6.0, 5.5, 5.3)
t.test(x, mu = 5)
#-- test-2
x <- c(12, 15, 11, 18, 14); y <- c(22, 19, 25, 21, 24)
t.test(x, y)
#-- test-3
x <- c(12, 15, 11, 18, 14); y <- c(22, 19, 25, 21, 24)
t.test(x, y, var.equal = TRUE)
#-- test-4
before <- c(200, 190, 210, 220); after <- c(190, 185, 200, 205)
t.test(before, after, paired = TRUE)
#-- test-5
x <- c(5.1, 4.9, 6.2, 5.8, 6.0, 5.5, 5.3)
t.test(x, mu = 5)$p.value
#-- test-6
chisq.test(matrix(c(10, 20, 30, 40), 2))
#-- test-7
chisq.test(c(20, 30, 50))
#-- test-8
x <- c(5.1, 4.9, 6.2, 5.8, 6.0)
t.test(x, alternative = "greater", mu = 5)
#-- test-9
prop.test(45, 100)
#-- test-10
binom.test(7, 20)
#-- test-11
cor.test(c(1, 2, 3, 4, 5, 6), c(2, 1, 4, 3, 7, 8))
#-- lm-1
x <- c(1, 2, 3, 4, 5); y <- c(2.1, 3.9, 6.2, 7.8, 10.1)
lm(y ~ x)
#-- lm-2
x <- c(1, 2, 3, 4, 5); y <- c(2.1, 3.9, 6.2, 7.8, 10.1)
coef(lm(y ~ x))
#-- lm-3
x <- c(1, 2, 3, 4, 5); y <- c(2.1, 3.9, 6.2, 7.8, 10.1)
summary(lm(y ~ x))
#-- lm-4
fit <- lm(mpg ~ wt, data = mtcars)
fit
#-- lm-5
fit <- lm(mpg ~ wt, data = mtcars)
summary(fit)
#-- lm-6
fit <- lm(mpg ~ wt + hp, data = mtcars)
summary(fit)
#-- lm-7
fit <- lm(mpg ~ wt, data = mtcars)
round(residuals(fit)[1:3], 4); round(fitted(fit)[1:3], 3)
#-- lm-8
fit <- lm(mpg ~ wt, data = mtcars)
predict(fit, data.frame(wt = c(3, 4)))
#-- lm-9
fit <- lm(mpg ~ wt, data = mtcars)
summary(fit)$r.squared; summary(fit)$coefficients
#-- lm-10
x <- c(1, 2, 3, 4, 5); y <- c(1, 4, 9, 16, 25)
lm(y ~ x + I(x^2))
#-- lm-11
fit <- lm(mpg ~ factor(cyl), data = mtcars)
coef(fit)
#-- lm-12
anova(lm(mpg ~ wt, data = mtcars))
#-- glm-1
fit <- glm(am ~ wt, data = mtcars, family = binomial)
coef(fit)
#-- glm-2
fit <- glm(am ~ wt, data = mtcars, family = binomial)
fit
#-- glm-3
fit <- glm(am ~ wt, data = mtcars, family = binomial)
summary(fit)
#-- glm-4
glm(count ~ x, family = poisson, data = data.frame(x = 1:6, count = c(1, 3, 2, 6, 8, 12)))
#-- misc-1
x <- 1:3; class(x); class(1); class("a"); class(TRUE); class(NULL); class(list()); class(sum)
#-- misc-2
typeof(1L); typeof(1); typeof(mean); is.numeric(1L); is.character("a")
#-- misc-3
as.numeric("3.5"); as.integer(3.9); as.character(1:3); as.logical(c("yes", "TRUE", "T"))
#-- misc-4
identical(c(1, 2), c(1, 2)); all.equal(1, 1 + 1e-10)
#-- misc-5
x <- 1:10
x[x > 3 & x < 8]
#-- misc-6
nchar(c("apple", "kiwi")); rev(list(1, "b"))
#-- misc-7
seq(10, 1)
#-- misc-8
print(1:3)
#-- misc-9
invisible(5)
#-- misc-10
x <- c(b = 2, a = 1)
x[order(names(x))]
#-- misc-11
max(c("apple", "banana")); sort(c("b", "A", "a", "B"))
#-- misc-12
round(123.456, -1); 1e15; 1e16; 0.1234567891
#-- misc-13
c(1.123456789, 123456.1)
#-- misc-14
100 * (1 + 0.05)^10
#-- misc-15
x <- c(1e5, 1e-5)
x
#-- misc-16
TRUE + TRUE
#-- misc-17
mean(1:10); median(c(1L, 2L)); 10 %/% 3L
#-- misc-18
x <- c(1, 2, 3)
x[5]
#-- misc-19
stop("bad input")
#-- misc-20
log(-1)
#-- misc-21
as.integer("x")
#-- misc-22
nchar(month.name)
#-- misc-23
exists("undefined_var_xyz"); is.null(NULL)
#-- misc-24
x <- matrix(c(1.5, NA, 3, 4), 2)
x
#-- misc-25
seq(0.5, 2.5)
#-- misc-26
Sys.Date() > as.Date("2020-01-01")
#-- misc-27
as.Date("2024-03-15") + 30
#-- misc-28
rev(sort(table(c("x", "y", "y", "z", "z", "z"))))
