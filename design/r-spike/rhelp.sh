#!/bin/bash
# rhelp.sh TOPIC [PKG]: print an R help page as text (docs only)
t=$1
ssh -o BatchMode=yes sagebrush-4 "TMPDIR=~/sbm-r/tmp ~/sbm-r/env/bin/Rscript --vanilla -e 'tools::Rd2txt(utils:::.getHelpFile(help(\"$t\")), options=list(underline_titles=FALSE))'" 2>&1
