#-- error-len-70
f <- function() stop(strrep("x", 55)); f()
#-- error-len-71
f <- function() stop(strrep("x", 56)); f()
#-- error-len-72
f <- function() stop(strrep("x", 57)); f()
#-- error-len-73
f <- function() stop(strrep("x", 58)); f()
#-- error-len-74
f <- function() stop(strrep("x", 59)); f()
#-- error-len-75
f <- function() stop(strrep("x", 60)); f()
#-- error-len-76
f <- function() stop(strrep("x", 61)); f()
#-- error-len-77
f <- function() stop(strrep("x", 62)); f()
#-- error-len-78
f <- function() stop(strrep("x", 63)); f()
#-- error-len-79
f <- function() stop(strrep("x", 64)); f()
#-- error-len-80
f <- function() stop(strrep("x", 65)); f()
#-- error-len-81
f <- function() stop(strrep("x", 66)); f()
#-- warning-len-67
f <- function() warning(strrep("w", 55)); f()
#-- warning-len-68
f <- function() warning(strrep("w", 56)); f()
#-- warning-len-69
f <- function() warning(strrep("w", 57)); f()
#-- warning-len-70
f <- function() warning(strrep("w", 58)); f()
#-- warning-len-71
f <- function() warning(strrep("w", 59)); f()
#-- warning-len-72
f <- function() warning(strrep("w", 60)); f()
#-- warning-len-73
f <- function() warning(strrep("w", 61)); f()
#-- warning-len-74
f <- function() warning(strrep("w", 62)); f()
#-- warning-len-75
f <- function() warning(strrep("w", 63)); f()
#-- warning-len-76
f <- function() warning(strrep("w", 64)); f()
#-- warning-len-77
f <- function() warning(strrep("w", 65)); f()
#-- warning-len-78
f <- function() warning(strrep("w", 66)); f()
#-- error-long-call
long_function_name_for_testing <- function(a, b) stop("short"); long_function_name_for_testing(1, 2)
#-- error-no-call
stop(strrep("y", 90))
#-- error-multiline-message
f <- function() stop("first line\nsecond line"); f()
