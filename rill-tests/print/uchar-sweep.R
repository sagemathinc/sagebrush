# Black-box sweep of R 4.5.3's character display: for every code point, the width print() pads it to
# (nchar type "width") and whether print() escapes it (encodeString differs from the character itself).
# Output: run-length ranges "start end width escaped", one per line.
cps <- c(0x20:0xD7FF, 0xE000:0x10FFFF)
out <- file("uchar-sweep.txt", "w")
chunk <- 65536L
prev <- NULL
for (lo in seq(1L, length(cps), by = chunk)) {
  ix <- lo:min(lo + chunk - 1L, length(cps))
  s <- intToUtf8(cps[ix], multiple = TRUE)
  w <- nchar(s, type = "width", allowNA = TRUE)
  e <- as.integer(encodeString(s) != s)
  for (k in seq_along(ix)) {
    cur <- c(w[k], e[k])
    if (!is.null(prev) && identical(cur, prev) && cps[ix[k]] == last + 1L) {
      last <- cps[ix[k]]
    } else {
      if (!is.null(prev)) writeLines(sprintf("%X %X %d %d", start, last, prev[1], prev[2]), out)
      start <- cps[ix[k]]; last <- start; prev <- cur
    }
  }
}
writeLines(sprintf("%X %X %d %d", start, last, prev[1], prev[2]), out)
close(out)
cat("done\n")
