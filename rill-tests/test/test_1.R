# Rill corpus: hypothesis tests. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
