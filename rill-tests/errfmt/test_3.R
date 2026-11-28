# Deparse spacing in an error's call: R writes /, %% and %/% tight, like ^ and :, and +, -, * and the comparisons spaced
#-- deparse-divide
"a" + 1/3
#-- deparse-divide-exponent
"a" + 1/3e9
#-- deparse-modulo
"a" + 7%%3
#-- deparse-intdiv
"a" + 7%/%3
#-- deparse-divide-chain
"a" + 1/2/3
#-- deparse-divide-unary
"a" + -1/2
#-- deparse-divide-paren
"a" + (1 + 2)/3
#-- deparse-spaced-still
"a" + 1 * 2 - 3
#-- deparse-power-colon
"a" + 2^3 + length(1:3)
