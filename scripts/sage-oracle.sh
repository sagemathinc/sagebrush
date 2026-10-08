#!/bin/bash
# Build Sage 10.10 from source in /scratch as an oracle for the doctests
# (scripts/doctest-oracle.py uses /scratch/sage-oracle/sage/sage when it
# exists).  Only the binaries are used: the GPL sources are never read for
# Sagebrush.  Singular, the other oracle (scratch tests of mpoly), comes from
# the distribution: sudo apt-get install singular.  About 30 minutes on 16
# cores; log in /scratch/sage-oracle/build.log:
#
#     bash scripts/sage-oracle.sh > /scratch/sage-oracle/build.log 2>&1
set -x
D=${SAGE_ORACLE:-/scratch/sage-oracle}
mkdir -p "$D" && cd "$D"
sudo -n apt-get install -y -q build-essential m4 bc patch perl tar xz-utils bzip2 python3 python3-venv \
  pkg-config autoconf automake libtool libssl-dev libffi-dev zlib1g-dev libbz2-dev liblzma-dev \
  libreadline-dev libsqlite3-dev libcurl4-openssl-dev gfortran cmake ninja-build git libboost-dev python3-setuptools python3-dev
if [ ! -d sage ]; then
  git clone -q --depth 1 --branch 10.10 https://github.com/sagemath/sage.git sage
fi
cd sage
export MAKE="make -j16"
export SAGE_NUM_THREADS=16
[ -f configure ] || ./bootstrap
./configure --prefix="$D/local" --with-python=/usr/bin/python3
make build
echo "SAGE BUILD EXIT $?"
./sage -c 'print(version()); R.<x,y>=QQ[]; print(factor(x^4-y^4)); print(integrate(sin(x)^2,x)); print(EuclideanSpace(2))'
