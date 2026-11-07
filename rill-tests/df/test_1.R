# Rill corpus: data frames. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- df-1
df <- data.frame(x = 1:3, y = c("a", "b", "c"))
df
#-- df-2
df <- data.frame(name = c("Ann", "Bob"), score = c(90.5, 85))
df$score; nrow(df); ncol(df); names(df)
#-- df-3
df <- data.frame(a = c(1.5, 2.25, 3), b = c(TRUE, FALSE, NA))
df
#-- df-4
df <- data.frame(g = c("x", "y", "x"), v = c(1, 2, 3))
df[df$v > 1, ]
#-- df-5
df <- data.frame(x = 1:5, y = c(2, 4, 6, 8, 10))
summary(df)
#-- df-6
df <- data.frame(x = 1:3)
df$z <- df$x^2
df
#-- df-7
df <- data.frame(x = 1:10)
head(df, 3)
#-- df-8
df <- data.frame(a = 1:2, b = 3:4)
str(df)
#-- df-9
df <- data.frame(x = c(3, 1, 2), y = c("c", "a", "b"))
df[order(df$x), ]
#-- df-10
df <- data.frame(g = c("a", "b", "a"), v = c(1, 5, 3))
aggregate(v ~ g, data = df, FUN = mean)
#-- df-11
head(mtcars)
#-- df-12
mean(mtcars$mpg); table(mtcars$cyl)
#-- df-13
df <- data.frame(x = 1:3, y = 4:6)
colMeans(df); sapply(df, class)
#-- df-14
df <- data.frame(x = c(1, 2), y = c("p", "q"), stringsAsFactors = TRUE)
levels(df$y); df[2, "x"]
#-- df-15
dim(iris); levels(iris$Species)
#-- df-16
with(mtcars, tapply(mpg, cyl, mean))
#-- df-17
subset(data.frame(a = 1:4, b = c(5, 6, 7, 8)), a > 2)
#-- df-18
df <- data.frame(x = c(-1.5, 22.25, 3))
df
