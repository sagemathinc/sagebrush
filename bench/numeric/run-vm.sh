#!/bin/bash
# On the spot VM: build track/numeric + PR 1 (from the public repo and a git bundle, no credentials), then time
# MATLAB mode (wasm under node, 1 core and all cores), NumPy/OpenBLAS (1 and 16 threads) and native engine/nd.
set -euxo pipefail
cd ~
OUT=~/bench-out
mkdir -p $OUT
lscpu > $OUT/lscpu.txt
git clone -q --filter=blob:none --branch track/numeric https://github.com/sagemathinc/sagebrush.git sb
cd sb
git fetch -q ~/meas.bundle HEAD:numeric-measure
git checkout -q numeric-measure
git log --oneline -1 > $OUT/commit.txt
pnpm install --frozen-lockfile > $OUT/install.log 2>&1
pnpm run build > $OUT/build.log 2>&1
node scripts/wasm-fetch.mjs > $OUT/wasm.log 2>&1
node --version >> $OUT/commit.txt
# MATLAB mode under node: engine/nd's wasm module; one core (taskset: no helper threads) and all 16
mkdir -p ~/m && cp ~/bench_matlab.m ~/m/main.m
(cd ~/m && taskset -c 0 node ~/sb/dist/src/cli.js --matlab main.m > $OUT/matlab-1.txt 2> $OUT/matlab-1.err)
(cd ~/m && node ~/sb/dist/src/cli.js --matlab main.m > $OUT/matlab-16.txt 2> $OUT/matlab-16.err)
# NumPy 2.5.1 / scipy-openblas, column-major inputs
python3 -m venv ~/npv && ~/npv/bin/pip -q install numpy==2.5.1
OPENBLAS_NUM_THREADS=1 taskset -c 0 ~/npv/bin/python ~/bench_numpy.py > $OUT/numpy-1.txt
OPENBLAS_NUM_THREADS=16 ~/npv/bin/python ~/bench_numpy.py > $OUT/numpy-16.txt
# native engine/nd: GEMM (AVX2+FMA kernel selected), 1, 8 and 16 threads; A \ b in MATLAB mode, 1 thread
cd ~/sb/engine
cargo run -q --release -p sagebrush-nd --features parallel --example gemm_bench -- 10,30,50,100,300,1000 1,8,16 21 > $OUT/native-gemm.jsonl 2> $OUT/native-gemm.err
cargo run -q --release -p sagebrush-nd --example solve_bench -- 10,30,50,100,300,1000 1 21 selected general matlab > $OUT/native-solve.jsonl 2> $OUT/native-solve.err
cargo run -q --release -p sagebrush-nd --example solve_bench -- 10,30,50,100,300,1000 1 21 selected spd matlab > $OUT/native-solve-spd.jsonl 2>> $OUT/native-solve.err
echo DONE > $OUT/DONE
