# Rill corpus: lists, A3 (review: an empty name never matches; unlist's arguments by the formal they match).
# Each case runs in a fresh R session; its recorded output is test_5.out.json (run.py --regen).
#-- list-empty-name-double-bracket
l <- list(a = 1, 2); l[[""]]; list(a = 1)[["", exact = FALSE]]
#-- list-empty-name-dollar
l <- list(a = 1, 2); l$""
#-- list-empty-name-bracket
l <- list(a = 1, 2); l[""]
#-- list-empty-name-bracket-mixed
list(a = 1, 2)[c("", "a")]; list(1, 2)[""]
#-- atomic-empty-name-bracket
c(a = 1, 2)[""]; c(a = 1, 2)[c("a", "")]; c(1, 2)[""]
#-- atomic-empty-name-double-bracket
c(a = 1, 2)[[""]]
#-- atomic-empty-name-double-bracket-inexact
c(a = 1)[["", exact = FALSE]]
#-- unlist-named-arguments
unlist(use.names = FALSE, x = list(a = 1, b = 2)); unlist(x = list(a = 1, b = 2), use.names = TRUE)
#-- unlist-positional-flags
unlist(list(a = 1, b = 2), TRUE, FALSE)
