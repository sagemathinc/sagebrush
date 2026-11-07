# Rill corpus: missing values. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- na-1
x <- c(1, NA, 3)
sum(x); sum(x, na.rm = TRUE); mean(x, na.rm = TRUE)
#-- na-2
is.na(c(1, NA, NaN, 4))
#-- na-3
NA > 1; NA & FALSE; NA | TRUE
#-- na-4
c(NA, "a")
#-- na-5
x <- c(2, NA, 5)
x[!is.na(x)]
#-- na-6
mean(c(NA, 1))
#-- na-7
NA_integer_; NA_real_; NA_character_; NULL
