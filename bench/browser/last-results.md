| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 383 | 3264 | 8.5× faster |
| rand(1000,1000) | 26.1 | 16.7 | 1.6× slower |
| randn(10^6) | 58.4 | 39.1 | 1.5× slower |
| sin (10^6, 2-D) | 15.3 | 9.5 | 1.6× slower |
| exp (10^6) | 8.2 | 7.1 | 1.2× slower |
| sqrt (10^6) | 7.2 | 2.7 | 2.7× slower |
| a*2+1 (10^6, 2-D) | 11.4 | 1.4 | 8.1× slower |
| a+a.T (10^6) | 6.8 | 1.5 | 4.5× slower |
| outer broadcast 1000x1000 | 7.6 | 1.4 | 5.4× slower |
| sum (10^6) | 0.9 | 0.5 | 1.8× slower |
| mean+std (10^6) | 15.7 | 2.4 | 6.5× slower |
| sum(axis=0) 1000x1000 | 1.4 | 0.5 | 2.8× slower |
| a[a>0.5] | 15.4 | 8.1 | 1.9× slower |
| sort 10^6 | 127.5 | 129.1 | 1.0× faster |
| argsort 10^5 ints | 11.5 | 5.5 | 2.1× slower |
| unique 10^5 ints | 9.4 | 1.5 | 6.3× slower |
| cumsum 10^6 | 5.9 | 3.8 | 1.6× slower |
| matmul 300x300 | 3.9 | 25.5 | 6.5× faster |
| inv 200x200 | 4.5 | 5.3 | 1.2× faster |
| det 1000x1000 | 124.3 | 189.3 | 1.5× faster |
| solve 200x200 | 2.6 | 1.7 | 1.5× slower |
| eigh 200x200 | 11.6 | 14.6 | 1.3× faster |
| svd 200x200 | 23.9 | 28 | 1.2× faster |
| eig 100x100 | 6.1 | 9.7 | 1.6× faster |
| fft 2^16 | 3.7 | 2.1 | 1.8× slower |
| rfft 10^6 | 22.4 | 15.7 | 1.4× slower |
| polyfit deg 5, 10^5 pts | 60 | 15.9 | 3.8× slower |
| histogram 10^6 | 53.5 | 41 | 1.3× slower |
| python loop a[i] 10^4 | 10.7 | 3.7 | 2.9× slower |
| tolist 10^6 | 13.5 | 38.4 | 2.8× faster |
| pure Python loop 10^6 | 16.2 | 175.8 | 10.9× faster |
| pure Python sieve 10^6 | 8.3 | 13.4 | 1.6× faster |
