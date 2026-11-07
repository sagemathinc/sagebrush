# Rill corpus: the apply family. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
