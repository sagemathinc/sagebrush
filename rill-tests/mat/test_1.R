# Rill corpus: matrices. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
