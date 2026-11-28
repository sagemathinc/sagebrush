# Rill corpus: strings, second review fixes (sprintf's integer conversions of doubles and logicals, R's one
# conversion of each argument for the first element, C's integer flags and precisions, NA, NaN and Inf in a field,
# precisions past a double's exact digits, formatC's digits). Each case runs in a fresh R session; its recorded
# output is test_4.out.json (run.py --regen).
#-- sprintf-x-2p31-error
sprintf("%x", 2^31 - 1)
sprintf("%x", 2^31)
#-- sprintf-x-minus-2p31-na
sprintf("%x", -2^31)
#-- sprintf-x-below-range-error
sprintf("%x", -2^31 - 1)
#-- sprintf-o-unsigned-max-error
sprintf("%o", 4294967295)
#-- sprintf-X-logical-error
sprintf("%X", NA)
#-- sprintf-d-out-of-range-error
sprintf("%5d", 1e10)
#-- sprintf-d-fraction-whole-vector-error
sprintf(c("%d", "%s"), 2.5)
#-- sprintf-d-minus-2p31-warns-once
sprintf("%d", c(-2147483648, 1, -2147483648))
sprintf("%d", c(NA, 3))
#-- sprintf-d-inf-error
sprintf("%d", Inf)
#-- sprintf-first-element-converts
sprintf(c("%x", "%x"), c(1, 2)); sprintf("%s %d", 1:2, 3); sprintf(c("%f", "%e"), c(1L, 2L)); sprintf("%f", TRUE)
sprintf(c("%s", "%s"), c(TRUE, NA)); sprintf("%5.1e", NA); sprintf("%s", NA_real_)
#-- sprintf-later-element-double-error
sprintf(c("%f", "%d"), c(1, 2))
#-- sprintf-later-element-integer-error
sprintf(c("%d", "%f"), c(1, 2))
#-- sprintf-later-element-character-error
sprintf(c("%s", "%5x"), c(1, 2.5))
#-- sprintf-later-element-logical-error
sprintf(c("%d", "%s"), c(TRUE, NA))
#-- sprintf-int-sign-flags
sprintf("%+x|% x|%+o|%+d|% d|%+5d", 1L, 1L, 1L, 1L, 1L, 1L)
sprintf("%+.3d|% 05d|%-+5d|%+05d", 7L, 7L, 7L, -7L)
#-- sprintf-int-precision
sprintf("%08.3x|%08.3d|%-8.3d|%.0d|%.0x|%5.0d|", 1L, 1L, 1L, 0L, 0L, 0L)
#-- sprintf-int-alternate
sprintf("%#x|%#X|%#o|%#.3o|%#5x|%#05x", 0L, 255L, 0L, 8L, 255L, 255L)
#-- sprintf-na-words
sprintf("[%05d|%+d|%-5d|%05.1f|%+f|%05s]", NA_integer_, NA_integer_, NA_integer_, NA_real_, Inf, NA)
sprintf("[%05.1f|%+.1f|% 6.1f|%-7.1e]", -Inf, Inf, NaN, -Inf)
sprintf("[% f|% .1f|%+f|% e|%+g|%+f|% f]", Inf, -Inf, NaN, Inf, Inf, NA_real_, NaN)
#-- sprintf-string-flags
sprintf("%5s|%-5s|%.0s|", NA, NA, "abc"); sprintf("%010s", "ab"); sprintf("%+s", "ab")
#-- sprintf-float-flags
sprintf("%#.0f|%#.0e|%#g|%g|%#x|%#X", 3, 3, 1, 1e-5, 255L, 0L)
sprintf("%010.2f|%-10.2f|%+010.2e|% 010.3g", -3.5, 3.5, 12345.678, 0.0001234)
#-- sprintf-wide-precision
nchar(sprintf("%.1200f", 1e-300)); substr(sprintf("%.1200f", 2^-1074), 1070, 1090)
substr(sprintf("%#.810g", 1/3), 800, 812); substr(sprintf("%#.810g", 1e-10), 800, 820)
substr(sprintf("%.850e", 1/3), 840, 860); nchar(sprintf("%-1030s|", "a"))
#-- formatC-digits-reduced
third <- 1/3
nchar(formatC(third, format = "f", digits = 1500))
nchar(formatC(third, format = "e", digits = 900))
nchar(formatC(c(third, 2), digits = 60))
#-- formatC-digits-width
formatC(c(2, 0.5, third <- 1/3, 100), digits = 10); formatC(2L, digits = 5, format = "g"); formatC(c(1L, 22L), digits = 3)
#-- formatC-widths
formatC("ab", width = -4); formatC(3.14159, width = 12, format = "f", digits = 2, flag = "0")
formatC(c(1L, -5L), width = 6, flag = "0"); formatC(255L, flag = "#", format = "d"); formatC(c(1L, NA), width = -5)
formatC(c(1L, 22L), width = 3, digits = 3, format = "d")
#-- substr-bounds
substr("abcdef", 0, 100); substr("abc", 3, 2); substr(c(a = "hello", b = NA), 2, 3)
