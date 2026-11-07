# Rill corpus: strings and output. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- str-1
paste("a", "b", sep = "-"); paste0("x", 1:3)
#-- str-2
paste(c("a", "b"), collapse = "+")
#-- str-3
nchar("hello"); toupper("abc"); tolower("ABC"); substr("abcdef", 2, 4)
#-- str-4
sprintf("%.2f", pi); sprintf("%5d|%-5s|", 42L, "ab"); sprintf("%e", 12345.6789)
#-- str-5
cat("Hello", "world\n")
#-- str-6
cat("x =", 3.14159, "\n")
#-- str-7
cat(1:5, sep = ", "); cat("\n")
#-- str-8
print("quoted")
#-- str-9
strsplit("a,b,c", ",");
#-- str-10
x <- "Statistics"
rev(strsplit(x, "")[[1]])
#-- str-11
format(3.14159, nsmall = 2); format(42L, width = 6); format(TRUE)
#-- str-12
formatC(3.14159, digits = 3, format = "f"); formatC(5, width = 3, flag = "0")
#-- str-13
toupper(letters[1:5])
#-- str-14
cat(sep = "", "a", "b\n")
#-- str-15
cat(TRUE, NA, 1L, 2.5, "s\n")
