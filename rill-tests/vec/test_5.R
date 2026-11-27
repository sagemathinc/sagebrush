#-- sub-grow
x <- 1:5
x[8] <- 10L
x
typeof(x)
#-- sub-coerce
x <- 1:3; x[2] <- 2.5; x
x <- c(1, 2); x[2] <- "a"; x
x <- c(TRUE, FALSE); x[1] <- 3L; x
x <- 1:3; x[2:3] <- c(1+1i, 2); x
#-- sub-names
x <- c(a = 1, b = 2)
x["c"] <- 3
x
x[5] <- 9
x
x <- c(b = 2, a = 1); x[c("a", "a")] <- c(5, 6); x
#-- sub-index-kinds
x <- 1:6; x[c(TRUE, FALSE)] <- 0L; x
x <- 1:5; x[-1] <- 0L; x
x <- 1:4; x[] <- 7L; x
x <- 1:3; x[0] <- 5L; x
x <- 1:3; x[1.9] <- 0L; x
x <- 1:3; x[-5] <- 0L; x
#-- sub-recycle
x <- 1:6; x[1:4] <- c(10L, 20L); x
#-- sub-recycle-warning
x <- 1:6; x[1:4] <- 1:3; x
#-- sub-null
x <- NULL; x[3] <- 1; x
#-- sub-copy-on-modify
x <- c(1, 2, 3)
y <- x
y[1] <- 100
x
y
#-- sub-condition
x <- c(1, 2, 3); x[x > 1] <- 0; x
x <- c(1, NA, 3); x[is.na(x)] <- 0; x
#-- sub-na-index
x <- 1:3; x[NA] <- 1L; x
x <- 1:3; x[2] <- NA; x; typeof(x)
#-- sub-error-na
x <- 1:3; x[c(1, NA)] <- 1:2
#-- sub-error-zero-length
x <- 1:3; x[2] <- integer(0)
#-- sub-error-null
x <- 1:3; x[2] <- NULL
#-- sub-error-negative
x <- 1:3; x[c(-1, 2)] <- 0L
#-- sub-error-unchanged
x <- 1:3
x[c(1, NA)] <- 4:5
#-- sub-error-not-found
y[1] <- 2
#-- sub2
x <- 1:3; x[[2]] <- 9L; x; x[[5]] <- 1L; x
x <- c(a = 1); x[["b"]] <- 2; x
x <- 1:3; x[["z"]] <- 1L; x
#-- sub2-error-length
x <- 1:3; x[[2]] <- 1:2
#-- sub2-error-zero
x <- 1:3; x[[0]] <- 1L
#-- names-assign
x <- 1:3
names(x) <- c("p", "q", "r")
x
names(x)[2] <- "Q"
x
names(x) <- NULL
x
#-- names-assign-short
x <- 1:3; names(x) <- c("a", "b"); x
#-- names-assign-numbers
x <- c(1, 2); names(x) <- 1:2; x; names(x)
#-- sub-value-returned
x <- 1:3
print(x[2] <- 5L)
(x[3] <- 7L)
x
