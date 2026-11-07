# Rill corpus: linear models. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
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
