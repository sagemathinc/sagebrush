# Rill corpus: strings, third review fixes (format's nsmall range, sprintf's NA integer under a precision, an NA
# format, formatC's negative digits). Each case runs in a fresh R session; its recorded output is test_5.out.json
# (run.py --regen).
#-- format-nsmall-range
format(c(1, 2), nsmall = 20); format(1, nsmall = 2.5); format(1, nsmall = -0.5); format(1, nsmall = TRUE)
#-- format-nsmall-too-large-error
format(c(1, 2), nsmall = 21)
#-- format-nsmall-na-error
format(1, nsmall = NA)
#-- sprintf-na-integer-precision
sprintf("[%08.0d|%5.1d|%.1x|%5.2d|%-6.1i|%.0d]", NA_integer_, NA_integer_, NA_integer_, NA_integer_, NA_integer_, NA)
sprintf("[%5.0f|%.1e|%6.1f|%.0g|%5.0f|%.0f]", NA_real_, NA_real_, NaN, Inf, NaN, -Inf)
sprintf("[%5.0s|%.1s]", NA, NA_character_); sprintf("%08.0d", c(1, -2147483648))
#-- sprintf-na-format
sprintf(c(NA_character_, "%d"), c(1L, 2L)); sprintf(NA_character_); sprintf(c("%d", NA), 1:2)
#-- formatC-negative-digits
formatC(c(0, 1/3, 1e-9), format = "f", digits = -1); formatC(1/3, digits = -1); formatC(1/3, format = "e", digits = -3)
formatC(1/3, format = "G", digits = -1, width = 12); formatC(3L, digits = -1); formatC(2, digits = -1)
formatC(1/3, format = "f", digits = 0)
