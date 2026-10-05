| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 412 | 3044 | 7.4× faster |
| rand(1000,1000) | 25.9 | 16.5 | 1.6× slower |
| randn(10^6) | 58.1 | 39.2 | 1.5× slower |
| sin (10^6, 2-D) | 15 | 9.4 | 1.6× slower |
| exp (10^6) | 7.6 | 7.3 | 1.0× slower |
| sqrt (10^6) | 6.6 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 6.1 | 1.2 | 5.1× slower |
| a+a.T (10^6) | 7.2 | 1.5 | 4.8× slower |
| outer broadcast 1000x1000 | 6.4 | 1.1 | 5.8× slower |
| sum (10^6) | 0.8 | 0.4 | 2.0× slower |
| mean+std (10^6) | 3.2 | 2.7 | 1.2× slower |
| sum(axis=0) 1000x1000 | 1.2 | 0.5 | 2.4× slower |
| a[a>0.5] | 15 | 8 | 1.9× slower |
| sort 10^6 | 125.5 | 128.7 | 1.0× faster |
| argsort 10^5 ints | 11.2 | 5.4 | 2.1× slower |
| unique 10^5 ints | 9.2 | 1.5 | 6.1× slower |
| cumsum 10^6 | 4.8 | 3.7 | 1.3× slower |
| matmul 300x300 | 3.5 | 25.2 | 7.2× faster |
| inv 200x200 | 4.2 | 5.3 | 1.3× faster |
| det 1000x1000 | 124.1 | 183.7 | 1.5× faster |
| solve 200x200 | 2 | 1.7 | 1.2× slower |
| eigh 200x200 | 11.6 | 14.5 | 1.3× faster |
| svd 200x200 | 23.5 | 28 | 1.2× faster |
| eig 100x100 | 5.9 | 9.4 | 1.6× faster |
| fft 2^16 | 3.1 | 2.1 | 1.5× slower |
| rfft 10^6 | 21.6 | 14.9 | 1.4× slower |
| polyfit deg 5, 10^5 pts | 54.6 | 15.1 | 3.6× slower |
| histogram 10^6 | 52.9 | 40.4 | 1.3× slower |
| python loop a[i] 10^4 | 10.5 | 3.5 | 3.0× slower |
| tolist 10^6 | 12.8 | 40.5 | 3.2× faster |
| pure Python loop 10^6 | 16.3 | 174.2 | 10.7× faster |
| pure Python sieve 10^6 | 7.8 | 13.1 | 1.7× faster |
