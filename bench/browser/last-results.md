| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 417 | 3244 | 7.8× faster |
| rand(1000,1000) | 8.1 | 16.7 | 2.1× faster |
| randn(10^6) | 24.2 | 39.1 | 1.6× faster |
| sin (10^6, 2-D) | 14.6 | 9.4 | 1.6× slower |
| exp (10^6) | 7.5 | 7.7 | 1.0× faster |
| sqrt (10^6) | 6.6 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 6.1 | 1.1 | 5.5× slower |
| a+a.T (10^6) | 6.8 | 1.5 | 4.5× slower |
| outer broadcast 1000x1000 | 5.7 | 1.7 | 3.4× slower |
| sum (10^6) | 0.9 | 0.5 | 1.8× slower |
| mean+std (10^6) | 3.5 | 2.2 | 1.6× slower |
| sum(axis=0) 1000x1000 | 1.2 | 0.5 | 2.4× slower |
| a[a>0.5] | 15.3 | 8 | 1.9× slower |
| sort 10^6 | 26.8 | 128.9 | 4.8× faster |
| argsort 10^5 ints | 2.5 | 5.6 | 2.2× faster |
| unique 10^5 ints | 3.5 | 1.5 | 2.3× slower |
| cumsum 10^6 | 5.1 | 3.7 | 1.4× slower |
| matmul 300x300 | 3.5 | 25.1 | 7.2× faster |
| inv 200x200 | 4.3 | 5.3 | 1.2× faster |
| det 1000x1000 | 123.1 | 186.7 | 1.5× faster |
| solve 200x200 | 2.3 | 1.7 | 1.4× slower |
| eigh 200x200 | 11.5 | 14.5 | 1.3× faster |
| svd 200x200 | 23 | 28.7 | 1.2× faster |
| eig 100x100 | 5.9 | 9.5 | 1.6× faster |
| fft 2^16 | 3.2 | 2 | 1.6× slower |
| rfft 10^6 | 22.1 | 14.9 | 1.5× slower |
| polyfit deg 5, 10^5 pts | 57.4 | 15.2 | 3.8× slower |
| histogram 10^6 | 53.1 | 40.5 | 1.3× slower |
| python loop a[i] 10^4 | 10.5 | 3.5 | 3.0× slower |
| tolist 10^6 | 13.7 | 38.2 | 2.8× faster |
| pure Python loop 10^6 | 16.3 | 175.9 | 10.8× faster |
| pure Python sieve 10^6 | 8.9 | 13.4 | 1.5× faster |
