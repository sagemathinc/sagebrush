# Rill corpus: strings, review fixes (paste of zero-length arguments, paste0's sep, sprintf's recycling, unsigned
# conversions and byte widths, simple case mapping). Each case runs in a fresh R session; its recorded output is
# test_3.out.json (run.py --regen).
#-- paste-all-empty
paste(character(0)); paste(character(0), character(0)); paste0(character(0)); paste(NULL); paste(NULL, character(0)); paste()
#-- paste-empty-mixed-collapse
paste(character(0), collapse = "+"); paste0(character(0), collapse = ""); paste(character(0), "a"); paste("a", NULL, "b")
#-- paste0-sep-is-data
paste0("a", sep = "b"); paste0("a", sep = "b", "c")
#-- sprintf-recycle-error
sprintf("%d:%d", 1:2, 1:3)
#-- sprintf-recycle-fmt-error
sprintf(c("%d", "%d!"), 1:3)
#-- sprintf-recycle-ok
sprintf("%d %d", 1:2, 1:4); sprintf(c("%d", "%d!"), 1:4)
#-- sprintf-unsigned
sprintf("%x", -1L); sprintf("%X", -1L); sprintf("%o", -1L); sprintf("%o", -8L)
#-- sprintf-unsigned-flags
sprintf("%5x|%-5X|%#x|%#o", 255L, 255L, 255L, 8L); sprintf("%x", 255); sprintf("%x", NA_integer_)
#-- sprintf-s-bytes
sprintf("[%3s]", "é"); sprintf("[%-3s]", "é"); sprintf("[%.2s]", "éa"); sprintf("[%5.3s]", "aéb")
#-- sprintf-s-precision-mid-character
sprintf("[%.1s]", "éa")
#-- case-simple-mapping
toupper("straße"); tolower("İ"); toupper(c("ᾀ", "ᾳ", "ὐ", "ﬁ"))
