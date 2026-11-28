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
#-- rep-named-arguments
rep(times = 2, x = 1:3); rep(t = 2, 1:3); rep(1:2, len = 3); rep(1:2, e = 2); rep(each = 2, 1:2, times = 2); rep(1:2, 2, 3); rep(1:2, 2, 3, 2)
rep_len(length.out = 4, x = 1:2); rep_len(len = 4, 1:2); rep_len(l = 3, x = 1:2)
#-- rep-zero-length
rep(numeric(0), length.out = 3); rep(character(0), length.out = 2); rep(c(a = 1)[0], length.out = 2); rep(integer(0), times = 3); rep(logical(0), each = 2, length.out = 3)
rep_len(numeric(0), 3); rep_len(NULL, 0); rep_len(character(0), 0); rep_len(c(a = 1, b = 2), 3)
#-- rep-null
rep(NULL, times = 2); rep(NULL, length.out = 0); rep(NULL, length.out = NA); rep(NULL, length.out = 3)
#-- rep-len-null-error
rep_len(NULL, 1)
#-- rep-counts-lenient
rep(1:3, length.out = NA); rep(1:3, length.out = 2.7); rep(1:2, each = NA); rep(1:2, each = 2.9); rep(1:2, each = 0); rep(1:2, times = -1, length.out = 3)
rep(1:2, times = c(1.9, 0.5)); rep(1:2, each = TRUE); rep(1:2, each = 1e10, length.out = 3); rep(c(a = 1, b = 2), each = 2, length.out = 3); rep(1:2, each = 2, times = 1:4)
#-- rep-counts-first-element
rep(1:3, length.out = c(4, 5))
rep(1:2, each = c(2, 3))
rep(1:2, each = integer(0))
#-- rep-error-length-out
rep(1:3, length.out = -1)
#-- rep-error-each-negative
rep(1:2, each = -1)
#-- rep-error-times-na
rep(1:2, times = c(1, NA))
#-- rep-error-times-after-each
rep(1:2, each = 2, times = c(1, 2))
#-- rep-len-error-na
rep_len(1:3, NA)
#-- rep-len-error-length
rep_len(1:3, c(2, 3))
#-- rep-len-lenient
rep_len(1:3, 2.5); rep_len(1:3, TRUE)
#-- seq-one-argument
seq(FALSE); seq(TRUE); seq(c(TRUE, FALSE)); seq(NA); seq(2.5); seq(-2)
#-- seq-one-argument-error
seq(NA_real_)
#-- seq-huge-ends
seq(-1e308, 1e308, by = 1e308); print(seq(-1e308, 1e308, by = 3e307), digits = 17); print(seq(-1.7e308, 1.7e308, by = 1e308), digits = 17); seq(1e308, -1e308, by = -1e308)
seq(-1e308, 1e308, length.out = 3); print(seq(-1e308, 1e308, length.out = 5), digits = 17); seq(1e308, -1e308, length.out = 3); seq(-1.7e308, 1.7e308, length.out = 2)
#-- seq-too-long
seq(-1e308, 1e308)
#-- colon-too-long
-1e308:1e308
#-- seq-by-much-too-small
seq(0, 1, by = 1e-10)
#-- seq-by-ratio-infinite
seq(0, 1e308, by = 1e-308)
#-- seq-tiny-span
seq(1, 1 + 2.2e-14, by = 1e-15); length(seq(1, 1 + 2.25e-14, by = 1e-15)); seq(4, 4 + 8.8e-14, by = 1e-14); length(seq(4, 4 + 9e-14, by = 1e-14)); seq(1e10, 1e10 + 1e-5, by = 1e-6); seq(-1, -1 - 1e-15, by = -1e-16)
#-- seq-length-out-type-rule
typeof(seq(1L, 5L, length.out = 3L)); typeof(seq(1L, by = 2L, length.out = 3L)); typeof(seq(1L, 5L, length.out = 3)); typeof(seq(1L, 4L, length.out = 3L)); typeof(seq(1L, by = 2L, length.out = 3))
typeof(seq(1L, by = 2, length.out = 3L)); typeof(seq(to = 5L, by = 2L, length.out = 3)); typeof(seq(to = 5L, length.out = 3L)); typeof(seq(to = 5L, length.out = 3)); typeof(seq(1L, length.out = 3L))
typeof(seq(1L, length.out = 3)); typeof(seq(by = 2L, length.out = 3L)); typeof(seq(TRUE, by = 2L, length.out = 2L)); seq(1L, 10L, length.out = 4L); seq(5L, 1L, length.out = 3L); seq(1L, 4L, length.out = 3L)
#-- seq-length-out-int-range
seq(1L, by = 2147483647L, length.out = 2L); typeof(seq(-2147483647L, by = -1L, length.out = 2L)); seq(to = 2147483647L, by = 2147483647L, length.out = 2L); typeof(seq(to = -2147483600L, by = 100L, length.out = 2L)); seq(-2147483647L, 2147483647L, length.out = 3L)
#-- seq-equal-ends
seq(TRUE, TRUE, length.out = 3); seq(1L, 1L, length.out = 3); seq(1L, 1, length.out = 2L); typeof(seq(1L, 1, length.out = 2L)); seq(1e308, 1e308, length.out = 2)
#-- seq-by-integer-like
typeof(seq(TRUE, 3L, by = 1L)); typeof(seq(to = 5L, by = 1L)); seq(FALSE, 2L, by = TRUE); typeof(seq(1, 10, by = 3L)); typeof(seq(1L, 10L, by = 3)); seq(5L, 1L, by = -2L)
#-- seq-length-out-first
seq(1, 10, length.out = c(2, 3))
#-- seq-by-much-too-small-ratio
seq(0, 1, by = 3.3e-10)
#-- seq-by-much-too-small-boundary
seq(0, 2147483648, by = 1)
#-- rep-empty-times
rep(integer(0), times = integer(0)); rep(logical(0), times = integer(0)); rep(character(0), times = numeric(0)); rep(1:3, each = 0, times = integer(0)); rep(integer(0), times = 1:2)
rep(integer(0), times = NA); rep(integer(0), times = -1); rep(integer(0), times = c(1, NA)); rep(integer(0), times = "a"); rep(integer(0), each = 2, times = integer(0)); rep(1:3, each = 0, times = 2)
rep(c(a = 1), each = 0, times = 3); rep(1:3, each = 0, length.out = 0); rep(1:3, each = 0, length.out = NA); rep(integer(0), each = 0, length.out = 3)
#-- rep-error-each-zero
rep(1:3, each = 0, length.out = 3)
#-- rep-error-each-zero-named
rep(c(a = 1, b = 2), each = 0, length.out = 2)
#-- rep-error-each-zero-times
rep(1:3, each = 0, times = 1:3)
#-- rep-error-empty-each
rep(integer(0), each = -1)
#-- seq-two-ends-types
seq(TRUE, FALSE, length.out = 2L); typeof(seq(TRUE, FALSE, length.out = 1L)); seq(FALSE, TRUE, length.out = 3L); seq(TRUE, FALSE, length.out = 2); seq(FALSE, 1L, length.out = 2L); seq(TRUE, 3, length.out = 2L)
seq(1L, 5L, length.out = 2); typeof(seq(1L, 2L, length.out = 1)); typeof(seq(1L, 5, length.out = 1L)); seq(5L, 1L, length.out = 2); seq(-2147483647L, 2147483647L, length.out = 2); seq(1L, 3L, length.out = 2.5)
seq(TRUE, FALSE, along.with = 1:2); seq(1L, 2L, along.with = 1:2)
