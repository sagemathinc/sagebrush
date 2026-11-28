# Rill corpus: lists, A3 (printing, `[`, `[[`, `$`, names, length, unlist).
# Each case runs in a fresh R session; its recorded output is test_2.out.json (run.py --regen).
#-- list-nested
list(1, list(2, 3))
#-- list-nested-named
list(a = 1, list(b = 2, 3))
#-- list-empty
list()
#-- list-null-element
list(a = NULL, 2)
#-- list-nonsyntactic-names
list(`a b` = 1, "if" = 2)
#-- list-empty-element
list(a = list())
#-- list-vector-elements
list(1:3, c(a = 1, b = 2))
#-- list-bracket
l <- list(a = 1, b = "x")
l[2]; l["a"]; l[c(TRUE, FALSE)]; l[-1]; l[3]
#-- list-bracket-empty
l <- list(1, "a")
l[NULL]; l[0]; length(l[c(1, 1, 1)])
#-- list-bracket-by-name-unnamed
list(1, 2)["z"]
#-- list-double-bracket
l <- list(alpha = 1, beta = "x", 3)
l[[3]]; l[["beta"]]; l[["al"]]; l[["al", exact = FALSE]]; l[[1.9]]; l[[NA]]
#-- list-double-bracket-out-of-bounds
l <- list(1, 2)
l[[3]]
#-- list-double-bracket-zero
l <- list(1, 2)
l[[0L]]
#-- list-double-bracket-zero-double
list(1, 2)[[0]]
#-- list-double-bracket-list-subscript
list(1, 2)[[list(1)]]
#-- list-double-bracket-empty
list()[[1]]
#-- list-dollar
l <- list(alpha = 1, beta = "x")
l$alpha; l$al; l$z; l$"beta"
#-- list-dollar-ambiguous
l <- list(ab = 1, ac = 2)
l$a; l$ab
#-- list-null-access
NULL[[1]]; NULL$a
#-- list-names-length
names(list(1, b = 2)); names(list(1, 2)); length(list()); length(list(1, list(2, 3)))
#-- list-is-list
is.list(list(1)); is.list(1); is.list(NULL)
#-- atomic-double-bracket
x <- c(a = 1, b = 2)
x[[2]]; x[["b"]]
#-- atomic-double-bracket-missing-name
x <- c(a = 1, b = 2)
x[["z"]]
#-- atomic-double-bracket-out-of-bounds
c(1, 2)[[3]]
#-- atomic-double-bracket-na
c(1, 2)[[NA]]
#-- atomic-double-bracket-zero
c(1, 2)[[0L]]
#-- unlist-nested
unlist(list(a = 1, b = list(c = 2, d = 3:4), 5))
#-- unlist-types
unlist(list(1, "a", TRUE)); unlist(list(1:2, 3L))
#-- unlist-inner-names
unlist(list(a = c(x = 1, y = 2), b = 3))
#-- unlist-sublists
unlist(list(a = list(1, 2), b = list(x = 3)))
#-- unlist-deep
unlist(list(a = list(b = list(c = 1))))
#-- unlist-repeated-tags
unlist(list(a = 1:2, a = 3)); unlist(list(a = 1, 2, b = 3))
#-- unlist-empty
unlist(list()); unlist(list(NULL)); unlist(c(1, 2))
#-- unlist-use-names
unlist(list(a = 1, b = 2), use.names = FALSE)
#-- letters
letters; LETTERS[1:3]
