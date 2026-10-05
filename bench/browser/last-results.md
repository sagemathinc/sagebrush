| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 389 | 3090 | 7.9× faster |
| rand(1000,1000) | 25.3 | 20.6 | 1.2× slower |
| randn(10^6) | 54.3 | 39.2 | 1.4× slower |
| sin (10^6, 2-D) | 14.8 | 9.3 | 1.6× slower |
| exp (10^6) | 24.1 | 7.2 | 3.3× slower |
| sqrt (10^6) | 6.5 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 9.9 | 1 | 9.9× slower |
| a+a.T (10^6) | 5.9 | 1.3 | 4.5× slower |
| outer broadcast 1000x1000 | 6.8 | 1 | 6.8× slower |
| sum (10^6) | 0.9 | 0.4 | 2.3× slower |
| mean+std (10^6) | 14.4 | 2.1 | 6.9× slower |
| sum(axis=0) 1000x1000 | 1.4 | 0.5 | 2.8× slower |
| a[a>0.5] | 15.1 | 8 | 1.9× slower |
| sort 10^6 | 127.7 | 128.5 | 1.0× faster |
| argsort 10^5 ints | 11.4 | 5.4 | 2.1× slower |
| unique 10^5 ints | 9.4 | 1.4 | 6.7× slower |
| cumsum 10^6 | 5.1 | 3.7 | 1.4× slower |
| matmul 300x300 | 3.6 | 25.2 | 7.0× faster |
| inv 200x200 | 4.3 | 5.2 | 1.2× faster |
| det 1000x1000 | 123.4 | 186.7 | 1.5× faster |
| solve 200x200 | 2.3 | 1.7 | 1.4× slower |
| eigh 200x200 | 11.9 | 14.4 | 1.2× faster |
| svd 200x200 | 23.2 | 27.7 | 1.2× faster |
| eig 100x100 | 5.9 | 9.2 | 1.6× faster |
| fft 2^16 | 4.9 | 2 | 2.5× slower |
| rfft 10^6 | 87.5 | 15.2 | 5.8× slower |
| polyfit deg 5, 10^5 pts | 66.2 | 14.6 | 4.5× slower |
| histogram 10^6 | 53.3 | 41.4 | 1.3× slower |
| python loop a[i] 10^4 | 10.2 | 3.5 | 2.9× slower |
| tolist 10^6 | 12.9 | 39.7 | 3.1× faster |
| pure Python loop 10^6 | 16.1 | 187.8 | 11.7× faster |
| pure Python sieve 10^6 | 7.9 | 13.3 | 1.7× faster |
