# %% and %/% with non-finite and extreme operands, and which missing value wins when NA meets NaN (R 4.5.3 x86-64)
#-- intdiv-nonfinite
NaN %/% 1
Inf %/% 1
-Inf %/% 3
Inf %/% Inf
1e300 %/% 1e-300
#-- intdiv-zero-divisor
c(1, -1, 0, NaN) %/% 0
1 %/% -0
#-- intdiv-infinite-divisor
c(0, 1, -1, 5.5, -5.5) %/% Inf
c(0, 1, -1, 5.5, -5.5) %/% -Inf
#-- intdiv-precision
1 %/% 0.1
-1 %/% 0.1
0.3 %/% 0.1
7 %/% 0.7
1e15 %/% 0.3
#-- mod-nonfinite
c(Inf, -Inf, NaN) %% 2
5 %% c(0, NaN)
1e300 %% 1e-300
#-- mod-infinite-divisor
c(0, 1, -1, 5.5, -5.5) %% Inf
c(0, 1, -1, 5.5, -5.5) %% -Inf
1/(-0 %% Inf)
1/(0 %% -Inf)
#-- mod-zero-sign
1/(c(-1, 1, -3, 3) %% 1)
1/(-0 %% 3)
#-- mod-precision
1 %% 0.1
0.3 %% 0.1
7 %% 0.7
#-- na-nan-order-left
is.nan(c(NaN + NA_real_, NA_real_ + NaN, NaN - NA_real_, NaN * NA_real_, NaN / NA_real_, NaN %/% NA_real_))
is.nan(c(NaN + NA_integer_, NaN + NA, NA_integer_ + NaN))
#-- na-nan-order-power-mod
is.nan(c(NaN^NA_real_, NA_real_^NaN, NA_real_^0, 1^NA_real_))
c(NaN^NA_real_, NA_real_^0, 1^NA_real_)
is.nan(c(NaN %% NA_real_, NA_real_ %% NaN, NA_real_ %% 0, 0 %% NA_real_))
