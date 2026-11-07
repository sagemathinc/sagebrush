# Rill corpus: random numbers. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
