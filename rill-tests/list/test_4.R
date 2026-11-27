# Rill corpus: lists, A3 (unlist's names under a nested tag: which leaves are free).
# Each case runs in a fresh R session; its recorded output is test_4.out.json (run.py --regen).
#-- unlist-free-named-vector
unlist(list(d = list(c(a = 1, 2), 3)))
#-- unlist-free-single-name
unlist(list(d = list(c(e = 3), 4)))
#-- unlist-free-untagged-list
unlist(list(d = list(e = 3, list(4))))
#-- unlist-free-two-named
unlist(list(d = list(c(a = 1), c(b = 2)))); unlist(list(d = list(c(a = 1), b = 2)))
#-- unlist-free-tagged-list-inside
unlist(list(d = list(x = list(4), 5))); unlist(list(d = list(x = list(4, 6), 5)))
#-- unlist-free-vector-only
unlist(list(d = list(c(1, 2)))); unlist(list(d = list(list(c(a = 1)), 2)))
