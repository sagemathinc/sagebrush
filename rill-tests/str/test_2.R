# Rill corpus: strings, edge cases (paste, nchar, case, substr, sprintf, format, formatC, the letter constants).
# Each case runs in a fresh R session; its recorded output is test_2.out.json (run.py --regen).
#-- paste-null-empty
paste("a", NULL, "b"); paste("a", character(0)); paste(character(0), collapse = "+"); paste0()
#-- paste-types-na
paste(1.5, 2L, TRUE, NA); paste(c("a", NA), 1:4, sep = "_")
#-- paste-doubles
paste(1/3, 1e-20, 1e15, 1e5, 100000)
#-- paste-names-dropped
x <- c(a = "ab", b = "cd"); paste(x, "z")
#-- nchar-na-number
nchar(c("hello", NA, "")); nchar(NA); nchar(123.45)
#-- nchar-names
nchar(c(a = NA, b = "x"))
#-- case-names-na
toupper(c(a = "ab", b = "cd")); toupper(NA); tolower(c("MiXeD", NA))
#-- substr-edges
substr("abcdef", 0, 2); substr(c("abc", "defg"), 2:3, 10); substr(NA, 1, 2); substr(c(a = "ab", b = "cd"), 1, 1)
#-- sprintf-vector-recycling
sprintf("%5s|%-4d|", c("a", "bb"), 1:2); sprintf("%s and %s", "x", c("y", "z"))
#-- sprintf-na-percent
sprintf("%d", NA_integer_); sprintf("%5.1f", NA); sprintf("%%"); sprintf("%s", TRUE); sprintf("%d", TRUE)
#-- sprintf-s-of-double
sprintf("%s", 1/3); sprintf("%d", 3)
#-- sprintf-d-of-fraction
sprintf("%d", 3.5)
#-- sprintf-names-dropped
sprintf("%s", c(a = "ab", b = "cd"))
#-- format-common-width
format(c(1, 10, 100)); format(c(1.5, NA)); format(c("a", "bbb")); format(c(TRUE, FALSE))
#-- format-nsmall-names
format(3.14159, nsmall = 7); format(2, nsmall = 2); format(c(a = 1, b = 22)); format(c("a", NA)); format(NA)
#-- formatc-defaults
formatC(c(123456.789, 0.000123456, 2, 1/3, 1e10, -2.5)); formatC(3.14159); formatC(42L)
#-- formatc-formats
formatC(c(123456.789, 1/3), format = "f"); formatC(1/3, format = "e"); formatC(123.456, format = "e", digits = 2)
#-- formatc-width-flag
formatC(c(1, 10, 100), width = 5); formatC(-5, width = 4, flag = "0"); formatC(3.14159, width = 8, flag = "-")
#-- formatc-na-names
formatC(c(1L, NA, 30L), width = 4); formatC(c(1.5, NA), format = "f", digits = 1); formatC(c(a = 1.5, b = 2), format = "f", digits = 1)
#-- formatc-logical
formatC(TRUE)
#-- letters-constants
LETTERS[24:26]; month.name[c(1, 12)]
#-- sprintf-na-width
sprintf("%5d", NA_integer_); sprintf("%-5d|", NA_integer_)
#-- format-width-nsmall
format(1.5, width = 8); format(c(1, 22.5), nsmall = 2); format("ab", width = 5)
