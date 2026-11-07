# Rill corpus: distributions. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
