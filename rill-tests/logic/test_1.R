# Rill corpus: logical operations. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- logic-1
TRUE && FALSE; TRUE || FALSE; !TRUE
#-- logic-2
c(TRUE, FALSE) & c(TRUE, TRUE)
#-- logic-3
xor(TRUE, FALSE); isTRUE(c(TRUE, TRUE))
#-- logic-4
sum(c(TRUE, TRUE, FALSE))
