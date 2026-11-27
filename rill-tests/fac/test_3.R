# Rill corpus: factors and cut, A3 (NaN levels, refactoring, collation of punctuation, cut's zero and duplicate breaks).
# Each case runs in a fresh R session; its recorded output is test_3.out.json (run.py --regen).
#-- fac-nan-level
factor(c(1.5, NaN, 2)); factor(c(NaN, NA, 1))
#-- fac-refactor-keeps-order
factor(factor(c("a", "b", "a"), levels = c("b", "a")))
#-- fac-refactor-ordered
factor(ordered(c("lo", "hi"), levels = c("lo", "hi"))); factor(factor(c("x", "y"))[1])
#-- fac-collation-punctuation
factor(c("a b", "ab", "a_b", "a-b", "a.b", "a", "_x", ".x", " x", "x", "a,b", "a;b", "a:b", "a!b", "a?b", "a'b"))
#-- fac-collation-symbols
levels(factor(c("a(b", "a)b", "a[b", "a]b", "a{b", "a}b", "a@b", "a*b", "a/b", "a&b", "a#b", "a%b", "a^b", "a+b", "a<b", "a=b", "a>b", "a|b", "a~b", "a$b", "a0b", "aAb")))
#-- cut-negative-zero
cut(0.5, c(-0, 1))
#-- cut-duplicate-breaks
cut(1, c(0, 1, 1))
