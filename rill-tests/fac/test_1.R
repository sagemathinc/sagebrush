# Rill corpus: factors and tables. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
