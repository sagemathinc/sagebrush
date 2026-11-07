# Rill corpus: vectors and indexing. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- vec-1
1:10
#-- vec-2
1:30
#-- vec-3
seq(0, 1, by = 0.1)
#-- vec-4
seq(1, 10, length.out = 4)
#-- vec-5
seq_len(5); seq_along(c("a", "b", "c"))
#-- vec-6
rep(1:3, times = 2); rep(1:3, each = 2); rep(c("x", "y"), times = c(2, 3))
#-- vec-7
x <- c(5, 3, 8, 1)
sort(x); order(x); rev(x); sort(x, decreasing = TRUE)
#-- vec-8
x <- c(a = 1, b = 2, c = 3)
x
#-- vec-9
x <- c(a = 1, b = 2, c = 3)
x["b"]; names(x)
#-- vec-10
x <- 1:10
x[x > 5]
#-- vec-11
x <- c(4, 8, 15, 16, 23, 42)
x[-1]; x[c(1, 3)]; x[length(x)]
#-- vec-12
x <- 1:5
x[8] <- 10L
x
#-- vec-13
which(c(FALSE, TRUE, TRUE, FALSE))
#-- vec-14
x <- c(3, 9, 2, 9)
which.max(x); which.min(x); range(x)
#-- vec-15
cumsum(1:10); cumprod(1:6)
#-- vec-16
x <- 101:150
x
#-- vec-17
c(1, "a", TRUE)
#-- vec-18
c(1, TRUE, FALSE)
#-- vec-19
length(NULL); c()
#-- vec-20
1:3 + 1:6
#-- vec-21
x <- c(1, 2, 3)
y <- x
y[1] <- 100
x; y
#-- vec-22
diff(c(1, 4, 9, 16))
#-- vec-23
unique(c(3, 1, 3, 2, 1)); duplicated(c(3, 1, 3, 2, 1))
#-- vec-24
x <- c(2.5, 1.25, 10)
x / 3
#-- vec-25
seq(-1, 1, 0.5)
#-- vec-26
any(c(1, 5) > 4); all(c(1, 5) > 4)
#-- vec-27
5 %in% c(1, 5, 9); match(c("b", "z"), c("a", "b"))
#-- vec-28
head(letters); tail(LETTERS, 3)
#-- vec-29
month.name[1:3]
#-- vec-30
x <- 1:12
x[x %% 2 == 0]
