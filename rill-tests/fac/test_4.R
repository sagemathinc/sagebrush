# Rill corpus: factors, A3 (review: ordered() of a factor, missing arguments, printing escapes, labels, cut).
# Each case runs in a fresh R session; its recorded output is test_4.out.json (run.py --regen).
#-- fac-ordered-of-factor
is.ordered(ordered(factor("x"))); ordered(factor(c("b", "a"))); ordered(factor(c("b", "a"), levels = c("b", "a")))
#-- fac-ordered-stays
is.ordered(factor(ordered("x"))); is.ordered(factor(ordered("x"), ordered = FALSE))
#-- fac-ordered-empty
ordered(character(0)); factor(character(0), ordered = TRUE)
#-- fac-print-escapes
factor("a", labels = "x\ny"); factor("a", labels = "t\tq"); factor("a\\b"); factor("q\"r")
#-- fac-print-escapes-named
factor(c(x = "a"), labels = "a\nb")
#-- fac-labels-na-prefix
factor(c("a", "b"), labels = NA_character_); factor(c("a", "b"), labels = NA)
#-- fac-is-missing-x
is.ordered()
#-- fac-is-factor-missing-x
is.factor()
#-- fac-nlevels-missing-x
nlevels()
#-- cut-labels-range
cut(c(1, 1 + 1e-13, 1 + 2e-13, 1 + 3e-13), c(1, 1 + 1e-13, 1 + 2e-13, 1 + 3e-13), include.lowest = TRUE)
levels(cut(1.5, c(1, 1.0000000000001, 2)))
#-- cut-labels-distinct-at-12
levels(cut(1.5, c(1, 1.00000000001, 2)))
#-- cut-number-with-na
cut(c(1, NA, 2), 2)
#-- cut-infinite-range
cut(c(1, 2, Inf), 2)
#-- cut-logical
cut(c(FALSE, TRUE), c(-1, 0.5, 2))
