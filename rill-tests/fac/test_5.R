# Rill corpus: factors, A3 (review: cut's number of intervals and dig.lab at their edges).
# Each case runs in a fresh R session; its recorded output is test_5.out.json (run.py --regen).
#-- cut-dig-lab-negative
levels(cut(0.15, c(0, 0.15, 1), dig.lab = -1)); levels(cut(0.1234567, c(0, 0.1234567, 1), dig.lab = -1))
levels(cut(c(1, 1.0000001), c(1, 1.0000001, 2), dig.lab = -5))
#-- cut-dig-lab-zero
levels(cut(0.15, c(0, 0.15, 1), dig.lab = 0)); levels(cut(0.15, c(0, 0.15, 1), dig.lab = 1))
#-- cut-dig-lab-wide
levels(cut(c(0.123456789, 0.5), c(0, 0.123456789, 1), dig.lab = 20))
#-- cut-dig-lab-fifty
levels(cut(0.15, c(0, 0.15, 1), dig.lab = 50))
#-- cut-dig-lab-infinite
cut(0.15, c(0, 0.15, 1), dig.lab = Inf)
#-- cut-dig-lab-nan
cut(0.15, c(0, 0.15, 1), dig.lab = NaN)
#-- cut-intervals-infinite
cut(c(1, 2), Inf)
#-- cut-intervals-too-many
cut(c(1, 2), 3e9)
#-- cut-intervals-invalid
cut(c(1, 2), -Inf)
