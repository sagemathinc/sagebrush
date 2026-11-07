# Rill corpus: descriptive statistics. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
