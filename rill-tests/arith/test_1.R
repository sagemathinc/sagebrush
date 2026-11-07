# Rill corpus: arithmetic and number printing. Seeded from the R feasibility spike (corpus.R, corpus2.R).
# Each case runs in a fresh R session; its recorded output is test_1.out.json (run.py --regen).
#-- arith-1
1 + 2
#-- arith-2
2^10
#-- arith-3
-2^2
#-- arith-4
7 %/% 2; 7 %% 2; -7 %/% 2; -7 %% 2
#-- arith-5
5 / 2
#-- arith-6
1/3
#-- arith-7
22/7
#-- arith-8
1e6
#-- arith-9
100000
#-- arith-10
123456789
#-- arith-11
1e-5
#-- arith-12
0.1 + 0.2
#-- arith-13
1/0; -1/0; 0/0
#-- arith-14
sqrt(2)
#-- arith-15
exp(1)
#-- arith-16
pi * 1e10
#-- arith-17
.Machine$integer.max
#-- arith-18
5L / 2L
#-- arith-19
c(1.5, 2, 3.25)
#-- arith-20
c(0.001, 1000)
#-- arith-21
c(1e-10, 1)
#-- arith-22
c(123456, 0.1)
#-- arith-23
x <- c(10.5, 3, NA, 7)
x * 2
#-- arith-24
round(3.14159, 2); signif(123456, 2); round(-2.5); round(0.5); round(1.5)
#-- arith-25
log(100); log10(1000); log(8, base = 2); log2(1024); log1p(0)
#-- arith-26
abs(-3:3)
#-- arith-27
floor(-2.5); ceiling(2.1); trunc(-2.7)
