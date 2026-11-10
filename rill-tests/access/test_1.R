#-- length
length(c(1, 2, 3))
#-- length-null
length(NULL)
#-- length-chr
length("abc")
#-- names-get
names(c(a = 1, b = 2))
#-- names-none
names(1:3)
#-- names-partial
names(c(a = 1, 2))
#-- idx-pos
x <- c(10, 20, 30); x[2]
#-- idx-vec
x <- c(10, 20, 30); x[c(3, 1)]
#-- idx-neg
x <- c(10, 20, 30); x[-1]
#-- idx-zero
x <- c(10, 20, 30); x[0]
#-- idx-zero-mixed
x <- c(10, 20, 30); x[c(0, 2)]
#-- idx-lgl
x <- c(10, 20, 30); x[c(TRUE, FALSE, TRUE)]
#-- idx-lgl-recycle
x <- c(10, 20, 30, 40); x[c(TRUE, FALSE)]
#-- idx-lgl-na
x <- c(10, 20, 30); x[c(TRUE, NA, FALSE)]
#-- idx-na
x <- c(10, 20, 30); x[NA]
#-- idx-na-int
x <- c(10, 20, 30); x[c(1, NA)]
#-- idx-oob
x <- c(10, 20, 30); x[5]
#-- idx-oob-chr
x <- c("a", "b"); x[3]
#-- idx-mixed-sign
x <- c(10, 20, 30); x[c(-1, 2)]
#-- idx-neg-oob
x <- c(10, 20, 30); x[-5]
#-- idx-frac
x <- c(10, 20, 30); x[2.9]
#-- idx-name
x <- c(a = 1, b = 2); x["b"]
#-- idx-name-missing
x <- c(a = 1, b = 2); x["z"]
#-- idx-named-keep
x <- c(a = 1, b = 2, c = 3); x[-2]
#-- idx-empty
x <- c(10, 20, 30); x[]
#-- idx-chr-on-unnamed
x <- 1:3; x["a"]
#-- idx-null
x <- c(10, 20); x[NULL]
#-- dollar-atomic
x <- c(a = 1); x$a
#-- ctor-integer
integer(3)
#-- ctor-numeric
numeric(2)
#-- ctor-double
double(2)
#-- ctor-character
character(2)
#-- ctor-logical
logical(2)
#-- ctor-complex
complex(2)
#-- ctor-negative
integer(-1)
#-- ctor-na
numeric(NA)
#-- ctor-frac
integer(2.7)
#-- as-integer-chr
as.integer("3.7")
#-- as-integer-dbl
as.integer(-3.7)
#-- as-integer-big
as.integer(3e9)
#-- as-numeric-chr
as.numeric(c("1.5", "abc", " 2 "))
#-- as-numeric-lgl
as.numeric(c(TRUE, FALSE, NA))
#-- as-character-dbl
as.character(c(1, 1.5, 1/3, 1e6, 1e15, 1e-20, 123456.7))
#-- as-character-int
as.character(c(1L, NA))
#-- as-logical-chr
as.logical(c("TRUE", "true", "T", "yes", "0", "F"))
#-- as-logical-num
as.logical(c(0, 2, NA, NaN))
#-- as-complex
as.complex(2)
#-- as-double
as.double(1:3)
#-- as-names-drop
as.numeric(c(a = 1))
#-- is-numeric
c(is.numeric(1), is.numeric(1L), is.numeric("1"), is.numeric(TRUE))
#-- is-character
c(is.character("a"), is.character(1))
#-- is-logical
c(is.logical(NA), is.logical(1))
#-- is-integer
c(is.integer(1L), is.integer(1))
#-- is-double
c(is.double(1), is.double(1L))
#-- is-complex
is.complex(1i)
#-- is-null
c(is.null(NULL), is.null(1))
#-- is-na
is.na(c(1, NA, NaN))
#-- is-na-chr
is.na(c("a", NA))
#-- is-na-named
is.na(c(a = 1, b = NA))
#-- is-nan
is.nan(c(1, NA, NaN))
#-- is-finite
is.finite(c(1, NA, Inf, NaN))
#-- is-infinite
is.infinite(c(1, NA, -Inf))
#-- is-vector
is.vector(1:3)
#-- c-names-nested
c(a = c(x = 1, y = 2), b = 3)
#-- c-names-vector
c(a = 1:2)
#-- c-names-inner-unnamed
c(a = c(x = 1, 2))
#-- c-names-inner-three
c(a = c(x = 1, 2, 3))
#-- c-names-leading-unnamed
names(c(1, b = 2))
#-- c-names-single-inner
c(a = c(x = 1))
#-- as-character-cplx
as.character(c(1+2i, 1/3+0i))
#-- as-character-cplx-big
as.character(complex(real = 1e15, imaginary = -0.5))
#-- as-numeric-hex
as.numeric(c("0x1A", "1e3", "-2.5", "Inf", "NA"))
#-- as-integer-na-string
as.integer("NA")
#-- as-logical-chr-more
as.logical(c("True", "False", "f", "t", "NA"))
#-- raw-refused
raw(2)
#-- as-raw-refused
as.raw(1)
#-- as-complex-chr-number
as.complex(c("2", "-1.5e3", "NA"))
#-- as-complex-chr-form-refused
as.complex("1+2i")
#-- as-complex-chr-bad
as.complex(c("abc", "1-"))
#-- as-integer-cplx-refused
as.integer(1+2i)
#-- index-cplx-refused
(1:3)[1i]
#-- complex-chr-part-refused
complex(real = "1")
#-- options-width-refused
options(width = 60)
#-- cat-fill-refused
cat(1, fill = TRUE)
#-- print-missing-x-first
print(digits = cat("E"))
#-- is-vector-missing-x-first
is.vector(mode = cat("E"))
#-- raw-refused-first
raw(cat("E"))
#-- as-raw-refused-first
as.raw(cat("E"))
#-- options-width-refused-first
options(width = cat("E"))
#-- options-unnamed-refused-first
options(cat("E"))
#-- print-x-after-digits
print(digits = 3, 1.23456)
#-- print-x-named-after-digits
print(digits = 3, x = c(a = 1.23456))
#-- is-vector-x-after-mode
is.vector(mode = "numeric", 1L)
#-- is-vector-x-named-after-mode
is.vector(mode = "character", x = 1)
#-- index-frac-negative
x <- c(10, 20, 30); x[-1.5]
#-- index-frac-positive
x <- c(10, 20, 30); x[2.9]
#-- index-frac-minus-half
x <- c(10, 20, 30); x[-0.5]
#-- index-frac-negatives
x <- c(10, 20, 30); x[c(-1.9, -2.2)]
#-- index-negative-na
x <- c(10, 20, 30); x[c(-1, NA)]
#-- index-duplicate-name
x <- c(a = 1, b = 2, a = 3); x["a"]
#-- index-duplicate-names
x <- c(a = 1, b = 2, a = 3); x[c("a", "b", "a")]
#-- complex-negative-zero-imag
print(complex(real = 1, imaginary = -0))
#-- complex-negative-zero-both
complex(real = -0, imaginary = -0)
#-- complex-negative-zero-vector
c(complex(real = 1, imaginary = -0), 2-3i)
#-- c-names-long-tag
c(abcdefghijklmnopqrstuvwxyz = c(1, 2, 3), abcdefghijklmnopqrstuvwxyz = c(p = 4, 5))
