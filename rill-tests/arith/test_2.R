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
#-- intdiv-large-opposite-signs
1.7e308 %/% -1e308
-1.7e308 %/% 1e308
1.79e308 %/% -1.5e308
1e308 %/% -3e307
1.7e308 %/% 1e308
#-- intdiv-extended-precision
c(10.2 %/% 2.8, -14.5 %/% 2.4, 20 %/% 3.3, 0.3 %/% -0.1, 1 %/% 0.1)
c(10.2 %% 2.8, 1 %% 0.1, 1e-300 %% -1, 0.3 %% 0.1)
1/(1e-300 %% -1)
#-- nan-integer-na-by-operator
is.nan(c(NaN + NA_integer_, NaN - NA_integer_, NaN * NA_integer_, NaN / NA_integer_, NaN %/% NA_integer_))
is.nan(c(NA_integer_ - NaN, NA_integer_ / NaN, NaN - NA, NaN / NA))
#-- mod-divisor-past-2-63
1.1 %% -1e300 == -1e300
-32 %% 1e300 == 1e300
z <- -0
1/c(z %% 1e300, z %% -1e300, z %% 1e19, z %% 2^63, z %% -2^63, z %% 3)
1/c((-2^64) %% 2^64, (-3*2^63) %% 2^63, (-2^70) %% 2^64)
#-- mod-loss-of-accuracy
1 %% 1e-300
c(2^63, 2^64) %% 1
1e300 %/% 0.1 > 0
#-- pow-zero-sign
1/c((-0)^1, (-0)^3, (-0)^1L, (-0)^TRUE, (-0)^-1, (-0)^-3, (-0)^2)
1/c((-Inf)^-1, (-Inf)^-3, (-Inf)^-1L)
c((-Inf)^1, (-Inf)^3, (-Inf)^0.5, (-Inf)^-0.5, (-0)^-0.5)
#-- known-extended-extremes
c((36.911 %/% -2.293720254535676e-15) == -1.6092197785240376e+16, (-1.3733456825083624e+16 %/% -0.1) == 1.3733456825083622e+17, (1.7e+308 %% -1.2828862476445937e+222) == 0.0, (-5.749890689885429e+170 %% 2.538704220085096e+159) == 1.98210190966578e+158)
#-- known-na-nan-vector-order
x <- c(NaN, NaN); y <- c(NA_real_, NA_real_)
is.nan(c(x + y, y + x, NaN + y, x * y, NaN * y))
is.nan(c(NaN, NaN) + c(NA_integer_, NA_integer_))
