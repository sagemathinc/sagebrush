# Rill corpus: control flow. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- ctrl-1
for (i in 1:3) print(i)
#-- ctrl-2
x <- 5
if (x > 3) "big" else "small"
#-- ctrl-3
i <- 0
while (i < 3) { i <- i + 1 }
i
#-- ctrl-4
f <- function(n) if (n <= 1) 1 else n * f(n - 1)
f(10)
#-- ctrl-5
ifelse(c(1, 5, 10) > 4, "hi", "lo")
#-- ctrl-6
total <- 0
for (v in c(2, 4, 6)) total <- total + v
total
#-- ctrl-7
s <- 0
repeat { s <- s + 1; if (s >= 4) break }
s
#-- ctrl-8
for (i in 1:5) { if (i %% 2 == 0) next; cat(i, "") }; cat("\n")
#-- ctrl-9
switch("b", a = "first", b = "second", "other")
#-- ctrl-10
x <- 3
y <- if (x > 5) 1 else 0
y
