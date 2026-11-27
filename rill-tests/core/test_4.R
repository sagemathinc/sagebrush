# cat(): a sep with a newline ends the output with one; a zero-length vector is an empty item, NULL is skipped
#-- cat-sep-newline
cat("a", "b", sep = "\n")
#-- cat-sep-newline-one
cat("a", sep = "\n")
cat("b\n")
#-- cat-sep-newline-none
cat(sep = "\n")
cat(NULL, sep = "\n")
cat("end\n")
#-- cat-sep-newline-inside
cat("a", "b", sep = "x\ny")
#-- cat-sep-space-newline
cat(1:3, sep = " \n")
#-- cat-sep-newline-empty-string
cat("a", "", sep = "\n")
#-- cat-sep-newline-null
cat("a", NULL, "b", sep = "\n")
#-- cat-zero-length
cat("a", character(0), "b")
cat("|\n")
cat("a", integer(0), "b", sep = "-")
cat("|\n")
cat(character(0), "b")
cat("|\n")
cat("a", character(0))
cat("|\n")
#-- cat-zero-length-newline
cat("a", character(0), "b", sep = "\n")
cat(character(0), sep = "\n")
cat("end\n")
#-- cat-null-skipped
cat("a", NULL, "b")
cat("|\n")
cat("a", c("x", "y"), "b", sep = "-")
cat("|\n")
#-- cat-no-newline-sep
cat("a", "b", sep = "")
cat("|\n")
cat("a", "b")
cat("|\n")
