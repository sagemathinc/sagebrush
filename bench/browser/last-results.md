| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 400 | 3079 | 7.7× faster |
| rand(1000,1000) | 25.7 | 16.7 | 1.5× slower |
| randn(10^6) | 54.7 | 43.6 | 1.3× slower |
| sin (10^6, 2-D) | 15.1 | 9.5 | 1.6× slower |
| exp (10^6) | 24.3 | 7.1 | 3.4× slower |
| sqrt (10^6) | 6.4 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 10.3 | 1.1 | 9.4× slower |
| a+a.T (10^6) | 7.6 | 1.6 | 4.7× slower |
| outer broadcast 1000x1000 | 6 | 1 | 6.0× slower |
| sum (10^6) | 0.9 | 0.5 | 1.8× slower |
| mean+std (10^6) | 14.8 | 2.3 | 6.4× slower |
| sum(axis=0) 1000x1000 | 1.3 | 0.5 | 2.6× slower |
| a[a>0.5] | 15 | 8 | 1.9× slower |
| sort 10^6 | 128.3 | 129.1 | 1.0× faster |
| argsort 10^5 ints | 11.4 | 5.5 | 2.1× slower |
| unique 10^5 ints | 9.3 | 1.5 | 6.2× slower |
| cumsum 10^6 | 5.3 | 3.8 | 1.4× slower |
| matmul 300x300 | 3.5 | 25.4 | 7.3× faster |
| inv 200x200 | 4.3 | 5.3 | 1.2× faster |
| det 1000x1000 | 123.9 | 183.8 | 1.5× faster |
| solve 200x200 | 2.4 | 1.7 | 1.4× slower |
| eigh 200x200 | 52.4 | 14.2 | 3.7× slower |
| svd 200x200 | 138.3 | 27.5 | 5.0× slower |
| eig 100x100 | 29.5 | 9.2 | 3.2× slower |
| fft 2^16 | 4.8 | 2.1 | 2.3× slower |
| rfft 10^6 | 85.6 | 15 | 5.7× slower |
| polyfit deg 5, 10^5 pts | 141.1 | 15.2 | 9.3× slower |
| histogram 10^6 | 53.2 | 40.9 | 1.3× slower |
| python loop a[i] 10^4 | 9.8 | 3.5 | 2.8× slower |
| tolist 10^6 | 13.6 | 39.4 | 2.9× faster |
| pure Python loop 10^6 | 16.1 | 186.7 | 11.6× faster |
| pure Python sieve 10^6 | 12.2 | 13.3 | 1.1× faster |
