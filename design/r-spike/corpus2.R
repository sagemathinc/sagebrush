## Rill spike held-out corpus: written after the prototype passed corpus.R, and scored BEFORE any fix.
## Typical intro-stats homework and lab snippets.
#-- h-1
heights <- c(165, 172, 158, 180, 175, 169)
mean(heights); sd(heights); length(heights)
#-- h-2
x <- c(12.5, 14.1, 9.8, 11.2, 13.7)
round(mean(x), 2); round(var(x), 3)
#-- h-3
scores <- c(78, 85, 92, 67, 88, 95, 72)
scores[scores >= 80]
#-- h-4
scores <- c(78, 85, 92, 67, 88, 95, 72)
sum(scores >= 80) / length(scores)
#-- h-5
x <- seq(2, 20, by = 2)
x
#-- h-6
z <- (c(60, 70, 80) - 70) / 10
z
#-- h-7
x <- c(3.2, 4.8, 5.1, 2.9, 6.3, 4.4)
summary(x)
#-- h-8
quantile(c(2, 4, 6, 8, 10, 12, 14), 0.9)
#-- h-9
x <- c(1, 3, 3, 5, 7, 7, 7, 9)
table(x)
#-- h-10
names(which.max(table(c("red", "blue", "red", "green", "red"))))
#-- h-11
prop.table(table(c("a", "b", "a", "a")))
#-- h-12
x <- c(10, 20, 30, 40)
x / sum(x)
#-- h-13
1 - pbinom(7, 10, 0.6)
#-- h-14
dbinom(0:3, 3, 0.2)
#-- h-15
sum(dbinom(8:10, 10, 0.7))
#-- h-16
pnorm(1) - pnorm(-1)
#-- h-17
qnorm(0.95, mean = 500, sd = 100)
#-- h-18
round(pt(-2.1, 15) * 2, 4)
#-- h-19
qt(c(0.025, 0.975), df = 9)
#-- h-20
x <- c(98.2, 98.6, 99.1, 97.9, 98.4, 98.8)
xbar <- mean(x); s <- sd(x); n <- length(x)
xbar + c(-1, 1) * qt(0.975, n - 1) * s / sqrt(n)
#-- h-21
ppois(3, lambda = 2.5, lower.tail = FALSE)
#-- h-22
punif(0.75, 0, 2) - punif(0.25, 0, 2)
#-- h-23
pexp(2, rate = 0.5)
#-- h-24
1 - pchisq(7.81, 3)
#-- h-25
set.seed(1)
x <- rnorm(100)
round(mean(x), 4)
#-- h-26
set.seed(99)
round(runif(4, 10, 20), 2)
#-- h-27
set.seed(5)
x <- rnorm(10, 50, 5)
round(summary(x), 2)
#-- h-28
x <- c(5, 7, 8, 9, 10, 12)
y <- c(2, 4, 5, 4, 7, 9)
round(cor(x, y), 4)
#-- h-29
x <- c(5, 7, 8, 9, 10, 12)
y <- c(2, 4, 5, 4, 7, 9)
fit <- lm(y ~ x)
coef(fit)
#-- h-30
x <- c(5, 7, 8, 9, 10, 12)
y <- c(2, 4, 5, 4, 7, 9)
summary(lm(y ~ x))
#-- h-31
x <- c(5, 7, 8, 9, 10, 12)
y <- c(2, 4, 5, 4, 7, 9)
fit <- lm(y ~ x)
predict(fit, newdata = data.frame(x = 11))
#-- h-32
fit <- lm(mpg ~ hp, data = mtcars)
summary(fit)
#-- h-33
fit <- lm(mpg ~ wt + qsec, data = mtcars)
coef(summary(fit))
#-- h-34
fit <- lm(Sepal.Length ~ Petal.Length, data = iris)
fit
#-- h-35
round(summary(lm(Sepal.Length ~ Petal.Length, data = iris))$r.squared, 4)
#-- h-36
fit <- lm(mpg ~ wt, data = mtcars)
confint(fit)
#-- h-37
t.test(mtcars$mpg, mu = 20)
#-- h-38
t.test(mpg ~ am, data = mtcars)
#-- h-39
a <- c(23, 25, 28, 30, 21); b <- c(30, 32, 29, 35, 33)
t.test(a, b, alternative = "less")
#-- h-40
a <- c(23, 25, 28, 30, 21); b <- c(30, 32, 29, 35, 33)
round(t.test(a, b)$statistic, 3)
#-- h-41
tab <- matrix(c(25, 15, 10, 30), nrow = 2)
chisq.test(tab, correct = FALSE)
#-- h-42
observed <- c(30, 25, 45)
chisq.test(observed, p = c(0.3, 0.3, 0.4))
#-- h-43
binom.test(60, 100, p = 0.5)
#-- h-44
prop.test(30, 80, p = 0.5, correct = FALSE)
#-- h-45
cor.test(mtcars$mpg, mtcars$wt)
#-- h-46
tapply(mtcars$hp, mtcars$gear, median)
#-- h-47
aggregate(mpg ~ cyl, data = mtcars, FUN = mean)
#-- h-48
table(mtcars$am, mtcars$gear)
#-- h-49
table(iris$Species)
#-- h-50
colMeans(iris[, 1:4])
#-- h-51
sapply(iris[1:4], mean)
#-- h-52
round(sapply(mtcars[, c("mpg", "hp")], sd), 2)
#-- h-53
nrow(subset(mtcars, mpg > 25))
#-- h-54
mtcars[mtcars$mpg > 30, c("mpg", "cyl")]
#-- h-55
head(mtcars[order(-mtcars$mpg), "mpg"], 5)
#-- h-56
df <- data.frame(student = c("A", "B", "C", "D"), exam1 = c(80, 75, 92, 68), exam2 = c(85, 70, 95, 72))
df$avg <- (df$exam1 + df$exam2) / 2
df
#-- h-57
df <- data.frame(x = c(1, 2, 3), y = c(2.5, 5.1, 7.4))
df[2, ]
#-- h-58
df <- data.frame(x = c(1, 2, 3), y = c(2.5, 5.1, 7.4))
df[df$y > 3, "x"]
#-- h-59
df <- data.frame(g = factor(c("ctl", "trt", "ctl", "trt")), w = c(4.17, 4.81, 5.58, 4.17))
str(df)
#-- h-60
df <- data.frame(g = factor(c("ctl", "trt", "ctl", "trt")), w = c(4.17, 4.81, 5.58, 4.17))
summary(df)
#-- h-61
summary(iris)
#-- h-62
str(mtcars[, 1:3])
#-- h-63
grades <- c("B", "A", "C", "A", "B", "A")
f <- factor(grades, levels = c("A", "B", "C"))
table(f)
#-- h-64
f <- factor(c("low", "high", "med", "low"), levels = c("low", "med", "high"), ordered = TRUE)
f
#-- h-65
f <- factor(c("low", "high", "med", "low"), levels = c("low", "med", "high"), ordered = TRUE)
f < "high"
#-- h-66
ages <- c(23, 35, 47, 52, 61, 19)
cut(ages, breaks = c(0, 30, 50, 100), labels = c("young", "middle", "old"))
#-- h-67
x <- c(4, NA, 7, NA, 10)
mean(x, na.rm = TRUE); sum(is.na(x))
#-- h-68
x <- c(4, NA, 7, NA, 10)
x[is.na(x)] <- 0
x
#-- h-69
complete.cases(data.frame(a = c(1, NA, 3), b = c("x", "y", NA)))
#-- h-70
v <- c(2, 4, 6)
v * c(1, 10, 100)
#-- h-71
m <- matrix(c(1, 2, 3, 4, 5, 6), nrow = 2, byrow = TRUE)
m
#-- h-72
A <- matrix(c(4, 2, 7, 6), 2)
solve(A) %*% A
#-- h-73
A <- matrix(c(2, 1, 1, 3), 2)
b <- c(1, 2)
solve(A, b)
#-- h-74
m <- matrix(1:6, 2)
dim(t(m)); m * 2
#-- h-75
sq <- function(n) { result <- numeric(n); for (i in 1:n) result[i] <- i^2; result }
sq(6)
#-- h-76
fib <- numeric(10); fib[1:2] <- 1
for (i in 3:10) fib[i] <- fib[i - 1] + fib[i - 2]
fib
#-- h-77
grade <- function(s) if (s >= 90) "A" else if (s >= 80) "B" else "C"
sapply(c(95, 85, 70), grade)
#-- h-78
cv <- function(x) sd(x) / mean(x) * 100
round(cv(c(10, 12, 14, 16)), 2)
#-- h-79
se <- function(x) sd(x) / sqrt(length(x))
se(c(4, 6, 8, 10))
#-- h-80
paste("Mean:", round(mean(c(1.234, 5.678)), 2))
#-- h-81
cat("The answer is", 42, "\n")
#-- h-82
cat(sprintf("%.3f\n", pi))
#-- h-83
print(paste0("n = ", 10))
#-- h-84
sprintf("%d of %d (%.1f%%)", 7L, 20L, 35)
#-- h-85
x <- c(a = 1.5, b = 2.25)
x * 2
#-- h-86
seq(0, 100, length.out = 5)
#-- h-87
rev(sort(c(3, 1, 4, 1, 5, 9, 2, 6)))[1:3]
#-- h-88
cumsum(c(5, 10, 15)) / 1:3
#-- h-89
round(exp(seq(0, 2, 0.5)), 3)
#-- h-90
x <- 1:20
x[x %% 3 == 0]
#-- h-91
toupper(substr("statistics", 1, 1))
#-- h-92
nchar(c("mean", "median", "mode"))
#-- h-93
any(is.na(c(1, 2, NA))); all(c(2, 4, 6) %% 2 == 0)
#-- h-94
length(unique(mtcars$cyl))
#-- h-95
round(var(mtcars$mpg), 3)
#-- h-96
x <- c(10, 15, 20, 25, 30)
(x - mean(x)) / sd(x)
#-- h-97
boxplot.stats(c(1, 2, 3, 4, 100))$out
#-- h-98
round(prop.table(table(mtcars$cyl)), 3)
#-- h-99
mean(iris$Petal.Width[iris$Species == "setosa"])
#-- h-100
with(iris, tapply(Sepal.Length, Species, mean))
#-- h-101
glm(vs ~ mpg, data = mtcars, family = binomial)
#-- h-102
round(coef(glm(vs ~ mpg, data = mtcars, family = binomial)), 4)
#-- h-103
x <- c(1, 2, 3, 4, 5, 6, 7, 8)
y <- c(1.1, 1.9, 3.2, 3.9, 5.1, 5.8, 7.2, 7.9)
anova(lm(y ~ x))
#-- h-104
x <- list(name = "Ann", scores = c(90, 85))
x$scores[2]
#-- h-105
ifelse(c(-2, 0, 3) > 0, "pos", "non-pos")
#-- h-106
max(c(4, 8, 2)) - min(c(4, 8, 2))
#-- h-107
var(1:10) == sd(1:10)^2
#-- h-108
seq(1, 2, by = 0.25)
#-- h-109
c(0.5, 100, 2500.75)
#-- h-110
c(1e-3, 2e-3, 1)
