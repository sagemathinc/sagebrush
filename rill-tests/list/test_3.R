# Rill corpus: lists, A3 (unlist's names for nested tags, zero-length named subsets, types).
# Each case runs in a fresh R session; its recorded output is test_3.out.json (run.py --regen).
#-- unlist-one-nameless
unlist(list(d = list(e = 3, 4)))
#-- unlist-several-nameless
unlist(list(d = list(e = 3, 4, 5))); unlist(list(d = list(3, e = 4, 5))); unlist(list(d = list(e = 3, 4:5)))
#-- unlist-named-vector-in-nested
unlist(list(d = list(e = 3, c(x = 4, 5)))); unlist(list(d = c(e = 3, 4)))
#-- unlist-two-levels
unlist(list(b = list(c = 2, d = list(e = 3, 4))))
#-- unlist-untagged-names
unlist(list(a = 1, c(x = 2), 3:4))
#-- unlist-type
unlist(list(1L, 2.5)); unlist(list(TRUE, 2L))
#-- unlist-atomic-keeps-names
unlist(c(a = 1, b = 2))
#-- list-named-zero-subset
list(a = 1)[0]
