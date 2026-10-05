| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 388 | 3036 | 7.8× faster |
| rand(1000,1000) | 26 | 16.8 | 1.5× slower |
| randn(10^6) | 55.1 | 39.3 | 1.4× slower |
| sin (10^6, 2-D) | 15 | 9.4 | 1.6× slower |
| exp (10^6) | 24.4 | 7.2 | 3.4× slower |
| sqrt (10^6) | 6.6 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 10.5 | 1.3 | 8.1× slower |
| a+a.T (10^6) | 6.7 | 1.4 | 4.8× slower |
| outer broadcast 1000x1000 | 7.5 | 1.1 | 6.8× slower |
| sum (10^6) | 0.8 | 0.4 | 2.0× slower |
| mean+std (10^6) | 14.7 | 2.7 | 5.4× slower |
| sum(axis=0) 1000x1000 | 1.3 | 0.5 | 2.6× slower |
| a[a>0.5] | 15 | 8.2 | 1.8× slower |
| sort 10^6 | 127.2 | 129.1 | 1.0× faster |
| argsort 10^5 ints | 11.4 | 5.5 | 2.1× slower |
| unique 10^5 ints | 9.1 | 1.5 | 6.1× slower |
| cumsum 10^6 | 5.3 | 3.8 | 1.4× slower |
| matmul 300x300 | 3.6 | 25.4 | 7.1× faster |
| inv 200x200 | 4.3 | 5.3 | 1.2× faster |
| det 1000x1000 | 122.1 | 187.4 | 1.5× faster |
| solve 200x200 | 2.5 | 1.7 | 1.5× slower |
| eigh 200x200 | 11.7 | 14.5 | 1.2× faster |
| svd 200x200 | 24 | 27.6 | 1.2× faster |
| eig 100x100 | 6.7 | 9.3 | 1.4× faster |
| fft 2^16 | 3.3 | 2 | 1.6× slower |
| rfft 10^6 | 24.8 | 14.8 | 1.7× slower |
| polyfit deg 5, 10^5 pts | 58.5 | 15.1 | 3.9× slower |
| histogram 10^6 | 53.5 | 40.8 | 1.3× slower |
| python loop a[i] 10^4 | 10.1 | 3.7 | 2.7× slower |
| tolist 10^6 | 11.7 | 39.9 | 3.4× faster |
| pure Python loop 10^6 | 16.3 | 169.9 | 10.4× faster |
| pure Python sieve 10^6 | 8.3 | 13.1 | 1.6× faster |
