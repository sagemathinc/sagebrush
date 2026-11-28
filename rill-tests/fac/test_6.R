# Rill corpus: factors, A3 (audit: one label and no levels; exclude without NA).
# Each case runs in a fresh R session; its recorded output is test_6.out.json (run.py --regen).
#-- fac-label-no-levels
factor(character(0), labels = "L"); nlevels(factor(character(0), labels = "L"))
levels(factor(1:2, levels = integer(0), labels = "L"))
#-- fac-label-one-level
factor("a", labels = "L"); factor(c("a", "b"), labels = "L")
#-- fac-labels-wrong-length-no-levels
factor(character(0), labels = c("L", "M"))
#-- fac-exclude-drops-a-level
factor(c("a", "b"), exclude = "b"); factor(c(NA, 1), exclude = c(NA, 2))
#-- fac-exclude-levels-given
factor(c(NA, "a"), levels = "a", exclude = "b")
#-- fac-exclude-keeps-na
as.character(factor(c(NA, "a"), exclude = "b", labels = "L"))
#-- fac-exclude-keeps-na-print
factor(c(NA, "a"), exclude = "b")
