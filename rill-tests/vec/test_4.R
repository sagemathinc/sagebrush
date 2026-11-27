#-- which
which(c(FALSE, TRUE, NA, TRUE)); which(c(a = TRUE, b = FALSE, c = TRUE)); which(logical(0)); which(c(1, 5, 3) > 2)
#-- which-error
which(1)
#-- which-max-min
which.max(c(3, 9, 2, 9)); which.min(c(3, 9, 2, 9)); which.max(c(a = 1, b = 5)); which.max(c(NA, 2, 1)); which.max(numeric(0)); which.max(c(TRUE, FALSE)); which.min(c(b = 3, a = 1))
#-- range
range(c(3, 9, 2)); range(c(3L, NA, 1L)); range(c(3L, NA, 1L), na.rm = TRUE); range(c("b", "a")); range(1:3, 10)
#-- cumsum-cumprod
cumsum(1:10); cumprod(1:6); cumsum(c(1, NA, 3)); cumsum(c(a = 1, b = 2)); cumsum(c(TRUE, TRUE)); cumprod(c(2, 0.5, 4))
#-- cum-extended-precision
print(cumsum(c(1, 1e-16, 1e-16, 1e-16, 1e-16)), digits = 17); print(cumsum(c(0.1, 0.2, 0.3)), digits = 17)
#-- cum-integer-overflow
cumsum(c(2147483647L, 1L, 5L))
#-- cummax-cummin
cummax(c(1, 3, 2, 5)); cummin(c(5, 3, 4, 1)); cummax(c(1, NA, 2)); cummax(c(2L, 1L, 3L)); cummin(c(x = 2, y = 1))
#-- diff
diff(c(1, 4, 9, 16)); diff(1:10, lag = 2); diff(c(1, 4, 9, 16), differences = 2); diff(5); diff(c(a = 1, b = 3, c = 6)); diff(integer(0)); diff(c(1, NA, 4))
#-- diff-error
diff(1:3, lag = 0)
#-- unique-duplicated
unique(c(3, 1, 3, 2, 1)); duplicated(c(3, 1, 3, 2, 1)); unique(c("b", "a", "b")); unique(c(NA, 1, NA)); unique(c(a = 1, b = 1)); duplicated(c(NA, NA)); unique(c("a", NA, "a", NA)); unique(NULL)
#-- any-all
any(c(1, 5) > 4); all(c(1, 5) > 4); any(c(NA, TRUE)); any(c(NA, FALSE)); all(c(NA, TRUE)); all(c(NA, FALSE)); any(); all(); any(c(NA, FALSE), na.rm = TRUE); all(logical(0)); all(1:2)
#-- any-coerce
any(1)
#-- in-match
5 %in% c(1, 5, 9); match(c("b", "z"), c("a", "b")); match(2, c(1, 2, 2)); match(NA, c(1, NA)); match(c(1, 2), c(2, 1), nomatch = 0); c(1, NA) %in% c(NA); match("1", 1); match(1L, 1.0); match(TRUE, c(0, 1)); c("a", "q") %in% c("q", "r")
#-- sort-order
x <- c(5, 3, 8, 1)
sort(x); order(x); sort(x, decreasing = TRUE); rev(sort(x))
#-- sort-na
sort(c(3, NA, 1)); sort(c(3, NA, 1), na.last = TRUE); order(c(3, NA, 1)); length(sort(c(NA, NA)))
#-- sort-names-ties
sort(c(b = 2, a = 1)); sort(c(b = 2, a = 1, c = 3), decreasing = TRUE); order(c(2, 1, 2, 1)); order(c(2, 1, 2, 1), decreasing = TRUE); order(c(1, 2), decreasing = TRUE)
#-- sort-types
sort(c(TRUE, FALSE, TRUE)); sort(integer(0)); typeof(sort(c(2L, 1L))); sort(c(3L, 1L, 2L)); sort(c("b", "a", "c"))
#-- order-keys
order(c(2, 1, 2), c(3, 2, 1)); order(c("b", "a", "b"), c(2, 9, 1))
