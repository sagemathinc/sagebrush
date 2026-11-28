# Rill corpus: factors and cut, A3 (factor, ordered, levels, nlevels, droplevels, as.vector, `[`, coercions, print).
# Each case runs in a fresh R session; its recorded output is test_2.out.json (run.py --regen).
#-- fac-print-na
factor(c("b", NA, "a"))
#-- fac-numbers
factor(c(3, 1, 2, 3)); factor(c(10, 2, 33, 2)); factor(c(-1, 0.5, 1e6, 1e-20)); factor(c(1L, 3L))
#-- fac-logical
factor(c(TRUE, FALSE))
#-- fac-empty
factor(character(0))
#-- fac-levels-given
factor(c("a", "b"), levels = c("b", "a", "z")); factor(c("a", "b", "a"), levels = "a")
#-- fac-labels
factor(c(1, 2, 1), labels = c("one", "two")); factor(c("x", "y"), labels = "L")
#-- fac-labels-wrong-length
factor(c("a", "b"), labels = c("x", "y", "z"))
#-- fac-exclude
factor(c("a", "b"), exclude = "a"); factor(c(1.5, 2.25, NA))
#-- fac-ordered
factor(c("a", "b"), ordered = TRUE); ordered(c("lo", "hi"), levels = c("lo", "hi"))
#-- fac-ordered-subset
factor(c("b", "a"), levels = c("a", "b"), ordered = TRUE)[2:1]
#-- fac-subset
f <- factor(c("u", "v", "u"))
f[2]; f[-1]; f[c(TRUE, FALSE)]; f[5]; f[0]; length(f)
#-- fac-coerce
f <- factor(c("a", "b", "a"))
as.character(f); as.vector(f); as.numeric(f); as.integer(factor(c("b", "a"))); as.logical(factor(c("TRUE", "x")))
#-- fac-tests
f <- factor(c("a", "b", "a"))
is.factor(f); is.numeric(f); is.integer(f); is.character(f); is.factor(1); is.ordered(factor("a")); is.ordered(ordered("a"))
#-- fac-levels-of-vector
levels(1:3); nlevels(1:3)
#-- fac-droplevels-order
droplevels(factor(c("a", "b", "c"), levels = c("c", "b", "a"))[c(1, 3)])
#-- fac-names
factor(c(p = "a", q = "bbb", rr = NA))
#-- fac-collation
factor(c("b", "B", "a", "A")); factor(c("a1", "a10", "a2", "_x", "1", "Z"))
#-- fac-long
factor(c("north", "south", "east", "west", "north", "south", "east", "west", "north", "south", "east", "west",
         "north", "south", "east"))
#-- cut-breaks
cut(c(1, 5, 9), breaks = c(0, 3, 6, 10))
#-- cut-number
cut(c(1, 5, 9), 3)
#-- cut-right-false
cut(c(1, 5, 9), breaks = c(0, 5, 10), right = FALSE)
#-- cut-labels
cut(c(1, 5, 9), breaks = c(0, 5, 10), labels = c("lo", "hi")); cut(c(1, 5, 9), breaks = c(0, 5, 10), labels = FALSE)
#-- cut-outside
cut(c(0, 11), breaks = c(0, 5, 10))
#-- cut-include-lowest
cut(c(0, 5), c(0, 5, 10), include.lowest = TRUE); cut(c(5, 10), c(0, 5, 10), include.lowest = TRUE, right = FALSE)
#-- cut-decimals
cut(c(0.5, 2.5), breaks = c(0, 1.25, 3)); cut(c(1.001, 1.002, 1.003), 2)
#-- cut-ordered
cut(c(1, 9), c(0, 5, 10), ordered_result = TRUE)
#-- cut-unsorted-breaks
cut(c(1, 9), c(10, 0, 5))
