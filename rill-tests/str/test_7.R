# Rill corpus: strings, fifth review fixes (sprintf's space flag on NA and NaN, format's trim with a width and
# with strings, formatC's NA, NaN and Inf fields and its strings' common width). Each case runs in a fresh R
# session; its recorded output is test_7.out.json (run.py --regen).
#-- sprintf-space-flag-na-nan
sprintf("[% G|% f|% e|% g|%+f|% 5.1f|%- 5f|% d|% s]", NA_real_, NA_real_, NA_real_, NA_real_, NA_real_, NA_real_, NA_real_, NA_integer_, NA)
sprintf("[% f|% 6f|%+ f]", NaN, NaN, NaN); sprintf("[%+ f|%+ 6.1f|% +e]", Inf, -Inf, Inf)
#-- format-trim-width
format("a", width = 3, trim = TRUE); format(1, width = 3, trim = TRUE); format(c("a", "bb"), trim = TRUE)
format(c(1, 10), trim = TRUE); format(c(1, 10), width = 4, trim = TRUE); format(c(TRUE, NA), trim = TRUE); format(c(1L, 10L), trim = TRUE)
#-- formatC-nonfinite-fields
formatC(Inf); formatC(Inf, width = 6); formatC(Inf, width = 6, flag = "-"); formatC(Inf, flag = "+"); formatC(Inf, flag = " ")
formatC(Inf, width = 6, flag = "0"); formatC(Inf, format = "f"); formatC(Inf, digits = 3); formatC(Inf, width = -6); formatC(Inf, format = "e", flag = "+", width = 7)
formatC(-Inf, digits = 3); formatC(NaN, width = 6, flag = "0"); formatC(NA_real_, digits = 3); formatC(NA_integer_, flag = "+")
#-- formatC-nonfinite-common-width
formatC(c(1, Inf, NA)); formatC(c(1, Inf, NA), width = 0); formatC(c(-1, NaN), flag = " "); formatC(c(1, NA)); formatC(c(NaN, NA))
formatC(c(-Inf, NA)); formatC(c(1, -Inf, NA, NaN)); formatC(c(Inf, 2.5, NA), width = 2); formatC(c(-Inf, NA), flag = "-"); formatC(c(1L, NA))
formatC(c(Inf, NA), format = "f", digits = 1); formatC(c(123456, NA, Inf)); formatC(c(Inf, NA), width = 5); formatC(c(-Inf, Inf, NaN))
formatC(c(-Inf, NA, NaN), width = 2, flag = "-"); formatC(c(1, 22.5, NA)); formatC(c(1L, 333L, NA)); formatC(c(1, NA), format = "f")
#-- formatC-strings-common-width
formatC(c("abc", "d")); formatC(c("abc", "d"), flag = "-"); formatC(c("abc", NA)); formatC(c("abc", NA), width = 5); formatC(NA_character_, flag = "-", width = 4)
formatC(c("abc", "d", NA)); formatC(c("a", NA)); formatC(c("abcd", NA, "b")); formatC(c("abc", NA), flag = "-"); formatC(c("abc", "d", NA), width = 2)
