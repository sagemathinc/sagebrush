#-- alloc-numeric-huge
numeric(1e11)
#-- alloc-numeric-80gb
numeric(1e10)
#-- alloc-integer-huge
integer(1e11)
#-- alloc-character-huge
character(1e11)
#-- alloc-logical-huge
logical(2e11)
#-- alloc-in-function
f <- function() numeric(1e11); f()
#-- alloc-assign
x <- numeric(1e11)
#-- alloc-rep
rep(1, 1e11)
#-- alloc-arith-recycle
x <- 1:3; y <- numeric(1e11) + x
#-- alloc-tb
numeric(1.5e12)
