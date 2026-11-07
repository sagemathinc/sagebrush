# Rill corpus: lists. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- list-1
l <- list(a = 1, b = "two", c = c(3, 4))
l
#-- list-2
l <- list(1, "a")
l
#-- list-3
l <- list(x = 1:3, y = letters[1:2])
l$x; l[["y"]]; names(l)
#-- list-4
l <- list(a = 1)
l$b <- 2
str(l)
#-- list-5
unlist(list(a = 1, b = 2:3))
#-- list-6
length(list(1, 2, list(3, 4)))
