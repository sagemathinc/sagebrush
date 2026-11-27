#-- seq-one-number
seq(5); seq(0); seq(-3); seq(2.5)
#-- seq-one-vector
seq(c(4, 5, 6)); seq("a")
#-- seq-from-to-types
typeof(seq(2, 8)); typeof(seq(2.5, 8)); seq(1.5, 4); seq(10, 1)
#-- seq-by
seq(1, 2, by = 0.3); seq(5, 1, by = -2); seq(0, 1, 0.25); seq(1, 10, by = 2.5)
#-- seq-by-types
typeof(seq(1, 10, by = 2)); typeof(seq(1L, 10L, by = 2L)); typeof(seq(1L, 10L, by = 2)); typeof(seq(1L, 10, by = 2L))
#-- seq-by-digits
print(seq(1, 2, by = 0.1), digits = 17)
#-- seq-by-step-tolerance
length(seq(0, 1 - 1e-12, by = 0.25)); length(seq(0, 1 - 1e-9, by = 0.25)); print(seq(0, 1 - 1e-12, by = 0.25), digits = 17)
#-- seq-by-from-equals-to
seq(1, 1, by = 0); seq(3, 3, by = 2)
#-- seq-length-out
seq(1, 10, length.out = 4); seq(0, 1, length.out = 3); seq(10, 0, length.out = 5); seq(1, 10, length.out = 2.5)
#-- seq-length-out-digits
print(seq(0.3, 0.9, length.out = 4), digits = 17); print(seq(0, 1, length.out = 11), digits = 17)
#-- seq-length-out-one-end
seq(5, length.out = 3); seq(to = 5, length.out = 3); seq(1, by = 2, length.out = 4); seq(to = 10, by = 2, length.out = 3)
#-- seq-length-out-types
typeof(seq(1L, 10L, length.out = 4)); typeof(seq(length.out = 3)); seq(length.out = 3); seq(1, 10, length.out = 0)
#-- seq-length-partial
seq(1, 10, length = 4); seq(2, 11, len = 4)
#-- seq-along-with
seq(along.with = c("a", "b", "c")); seq(2, along.with = 1:3)
#-- seq-error-sign
seq(1, 10, by = -1)
#-- seq-error-by-zero
seq(1, 10, by = 0)
#-- seq-error-to-na
seq(1, NA)
#-- seq-error-from-length
seq(1:2, 5)
#-- seq-error-length-out
seq(1, 10, length.out = -2)
#-- seq-error-too-many
seq(1, 2, 3, 4)
#-- seq-error-too-many-named
seq(1, 10, by = 3, length.out = 2)
#-- seq-len
seq_len(5); seq_len(0); seq_len(3.7); typeof(seq_len(2))
#-- seq-len-first-used
seq_len(c(2, 5))
#-- seq-len-error
seq_len(-1)
#-- seq-len-error-na
seq_len(NA)
#-- seq-along
seq_along(c("a", "b", "c")); seq_along(NULL); seq_along(c(x = 1, y = 2))
#-- rep-times
rep(1:3, times = 2); rep(1:3, 2); rep("x", 3); rep(TRUE, 2.9)
#-- rep-times-vector
rep(c("x", "y"), times = c(2, 3)); rep(1:2, times = c(0, 3))
#-- rep-each
rep(1:3, each = 2); rep(1:3, each = 2, times = 2); rep(c("a", "b"), each = 3)
#-- rep-length-out
rep(1:3, length.out = 7); rep(1:2, times = 2, length.out = 3); rep(1:3, each = 2, length.out = 5); rep(1:2, length.out = 0)
#-- rep-names
rep(c(a = 1, b = 2), 2); rep(c(a = 1, b = 2), each = 2); rep(c(a = 1, b = 2), length.out = 3)
#-- rep-empty
rep("x", 0); rep(NULL, 3); rep(character(0), 2)
#-- rep-error-times
rep(1:3, times = -1)
#-- rep-error-times-length
rep(1:3, times = c(1, 2))
#-- rep-error-each
rep(1:3, each = -1)
#-- rep-len
rep_len(1:3, 5); rep_len(c(a = 1, b = 2), 3); rep_len("z", 2); rep_len(1:4, 2)
#-- rep-len-error
rep_len(1:3, -1)
#-- rev
rev(1:5); rev(c(a = 1, b = 2, c = 3)); rev(c("x", "y")); rev(NULL); rev(numeric(0))
#-- rev-na
rev(c(1, NA, 3)); rev(c(TRUE, NA))
