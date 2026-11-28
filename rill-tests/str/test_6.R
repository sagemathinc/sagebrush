# Rill corpus: strings, fourth review fixes (formatC's width from digits: a width of 0, an integer's default digits,
# a string's width). Each case runs in a fresh R session; its recorded output is test_6.out.json (run.py --regen).
#-- formatC-width-zero
formatC(2, digits = -1, width = 0); formatC(3L, digits = -3, width = 0); formatC(2, width = 0); formatC(2, digits = 3, width = 0)
formatC(2L, width = 0); formatC(1/3, digits = 2, width = 0, format = "f"); formatC(2L, digits = 2, width = 0); formatC(2L, digits = 2)
formatC(c(a = 1, b = 2), digits = 1, width = 0); formatC(2, width = NULL); formatC(2, digits = NULL, width = 3); formatC(2, digits = NULL)
#-- formatC-width-zero-digits-zero-error
formatC(2, digits = 0, width = 0)
#-- formatC-string-width
formatC("x", width = 0); formatC("x", digits = -1); formatC("x", digits = 1); formatC("x", digits = 3, width = 0)
formatC(c("ab", "c"), digits = 5, width = -3)
#-- formatC-integer-float-format
formatC(12345L, format = "f"); formatC(12345L, format = "f", digits = NULL); formatC(12345L, format = "f", width = 0); formatC(12345L, format = "f", digits = 2)
formatC(12345L, format = "e"); formatC(12345L, format = "e", digits = NULL); formatC(12345L, format = "e", width = 0); formatC(12345L, format = "e", digits = 2)
formatC(12345L, format = "E"); formatC(12345L, format = "E", digits = NULL); formatC(12345L, format = "E", width = 0); formatC(12345L, format = "E", digits = 2)
formatC(12345L, format = "g"); formatC(12345L, format = "g", digits = NULL); formatC(12345L, format = "g", width = 0); formatC(12345L, format = "g", digits = 2)
formatC(12345L, format = "G"); formatC(12345L, format = "G", digits = NULL); formatC(12345L, format = "G", width = 0); formatC(12345L, format = "G", digits = 2)
formatC(12345L); formatC(12345L, width = 0); formatC(2L, format = "f", width = 0); formatC(c(1L, NA), format = "e")
