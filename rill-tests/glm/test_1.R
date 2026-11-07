# Rill corpus: generalized linear models. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
