#-- ctor-named
numeric(length = 3)
#-- ctor-partial
numeric(len = 3)
#-- ctor-partial-1
numeric(l = 2)
#-- ctor-positional
integer(2)
#-- ctor-default
integer()
#-- ctor-unused-pos
numeric(3, 4)
#-- ctor-unused-named
numeric(foo = 1)
#-- ctor-unused-two
numeric(3, foo = 1, 5)
#-- ctor-multiple
numeric(length = 1, length = 2)
#-- ctor-multiple-partial
numeric(length = 1, len = 2)
#-- ctor-exact-beats-partial
character(length = 2L)
#-- ctor-two-partials
numeric(len = 2, le = 3)
#-- ctor-length-string
integer('3')
#-- ctor-length-logical
numeric(TRUE)
#-- ctor-length-two
integer(c(2, 5))
#-- closure-missing
is.vector()
#-- primitive-misnamed-as
as.character(y = 1)
#-- primitive-partial-name
length(xx = 1:3)
#-- primitive-named-then-extra
length(x = 1, 2)
#-- primitive-is-na-misnamed
is.na(y = 1)
#-- complex-named-then-positional
complex(real = 1, 2)
#-- print-extra-positional
print(1:3, digits = 3, 5)
#-- index-two-dims
x <- 1:3; x[1, 2]
#-- options-digits-too-big
options(digits = 30)
#-- options-digits-zero
options(digits = 0)
#-- options-scipen-string
options(scipen = 'a')
#-- complex-named
complex(real = 1, imaginary = 2)
#-- complex-partial
complex(re = 1, im = -1)
#-- complex-mod-arg
complex(modulus = 2, argument = 0)
#-- complex-length
complex(length.out = 2)
#-- complex-positional
complex(2, 1, 3)
#-- before-eval-unused
x <- 1; try_it <- 0; numeric(x <- 3, foo = 1)
#-- before-eval-check
x <- 1; numeric(x <- 3, foo = 1); x
#-- cat-after-dots-partial
cat(1, se = "-")
#-- cat-after-dots-exact
cat(1, 2, sep = "-")
#-- cat-after-dots-ambiguous
cat(1, fi = TRUE)
#-- length-none
length()
#-- length-two
length(1, 2)
#-- length-named
length(x = 1:3)
#-- length-misnamed
length(y = 1:3)
#-- names-none
names()
#-- is-na-none
is.na()
#-- is-na-two
is.na(1, 2)
#-- is-numeric-none
is.numeric()
#-- as-integer-none
as.integer()
#-- as-numeric-two
as.numeric("1", "2")
#-- as-character-named
as.character(x = 1)
#-- is-vector-mode
is.vector(1, mode = "numeric")
#-- is-vector-mode-partial
is.vector(1, m = "character")
#-- is-vector-unused
is.vector(1, 2, 3)
#-- options-set
options(digits = 4); 1/3
#-- options-old-invisible
options(digits = 4)
#-- options-old-visible
(options(digits = 4))
#-- print-digits
print(1/3, digits = 3)
#-- print-digits-partial
print(1/3, dig = 2)
