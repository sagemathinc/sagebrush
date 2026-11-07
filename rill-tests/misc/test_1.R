# Rill corpus: miscellaneous. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- misc-1
x <- 1:3; class(x); class(1); class("a"); class(TRUE); class(NULL); class(list()); class(sum)
#-- misc-2
typeof(1L); typeof(1); typeof(mean); is.numeric(1L); is.character("a")
#-- misc-3
as.numeric("3.5"); as.integer(3.9); as.character(1:3); as.logical(c("yes", "TRUE", "T"))
#-- misc-4
identical(c(1, 2), c(1, 2)); all.equal(1, 1 + 1e-10)
#-- misc-5
x <- 1:10
x[x > 3 & x < 8]
#-- misc-6
nchar(c("apple", "kiwi")); rev(list(1, "b"))
#-- misc-7
seq(10, 1)
#-- misc-8
print(1:3)
#-- misc-9
invisible(5)
#-- misc-10
x <- c(b = 2, a = 1)
x[order(names(x))]
#-- misc-11
max(c("apple", "banana")); sort(c("b", "A", "a", "B"))
#-- misc-12
round(123.456, -1); 1e15; 1e16; 0.1234567891
#-- misc-13
c(1.123456789, 123456.1)
#-- misc-14
100 * (1 + 0.05)^10
#-- misc-15
x <- c(1e5, 1e-5)
x
#-- misc-16
TRUE + TRUE
#-- misc-17
mean(1:10); median(c(1L, 2L)); 10 %/% 3L
#-- misc-18
x <- c(1, 2, 3)
x[5]
#-- misc-19
stop("bad input")
#-- misc-20
log(-1)
#-- misc-21
as.integer("x")
#-- misc-22
nchar(month.name)
#-- misc-23
exists("undefined_var_xyz"); is.null(NULL)
#-- misc-24
x <- matrix(c(1.5, NA, 3, 4), 2)
x
#-- misc-25
seq(0.5, 2.5)
#-- misc-26
Sys.Date() > as.Date("2020-01-01")
#-- misc-27
as.Date("2024-03-15") + 30
#-- misc-28
rev(sort(table(c("x", "y", "y", "z", "z", "z"))))
