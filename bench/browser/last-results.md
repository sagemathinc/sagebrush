| benchmark (ms, best of runs) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio |
|---|---:|---:|---:|
| startup to `import numpy` (cold cache) | 409 | 3217 | 7.9× faster |
| rand(1000,1000) | 25.1 | 16.7 | 1.5× slower |
| randn(10^6) | 54.2 | 39.1 | 1.4× slower |
| sin (10^6, 2-D) | 14.8 | 9.4 | 1.6× slower |
| exp (10^6) | 23.9 | 7.1 | 3.4× slower |
| sqrt (10^6) | 6.6 | 2.7 | 2.4× slower |
| a*2+1 (10^6, 2-D) | 9.9 | 1 | 9.9× slower |
| a+a.T (10^6) | 5.8 | 1.5 | 3.9× slower |
| outer broadcast 1000x1000 | 6.1 | 1.1 | 5.5× slower |
| sum (10^6) | 0.9 | 0.4 | 2.3× slower |
| mean+std (10^6) | 14.3 | 2.2 | 6.5× slower |
| sum(axis=0) 1000x1000 | 1.3 | 0.5 | 2.6× slower |
| a[a>0.5] | 14.8 | 8.1 | 1.8× slower |
| sort 10^6 | 126.7 | 128.9 | 1.0× faster |
| argsort 10^5 ints | 11.2 | 5.5 | 2.0× slower |
| unique 10^5 ints | 9 | 1.4 | 6.4× slower |
| cumsum 10^6 | 4.8 | 3.7 | 1.3× slower |
| matmul 300x300 | 25.4 | 25.3 | 1.0× slower |
| inv 200x200 | 16.4 | 5.2 | 3.2× slower |
| det 1000x1000 | 493 | 185.9 | 2.7× slower |
| solve 200x200 | 5.2 | 1.7 | 3.1× slower |
| eigh 200x200 | 44.8 | 14.6 | 3.1× slower |
| svd 200x200 | 125.5 | 27.9 | 4.5× slower |
| eig 100x100 | 47.3 | 9.4 | 5.0× slower |
| fft 2^16 | 5 | 2.1 | 2.4× slower |
| rfft 10^6 | 76.1 | 15.2 | 5.0× slower |
| polyfit deg 5, 10^5 pts | 75.8 | 15.5 | 4.9× slower |
| histogram 10^6 | 53.8 | 40.8 | 1.3× slower |
| python loop a[i] 10^4 | 9.9 | 3.5 | 2.8× slower |
| tolist 10^6 | 12.9 | 43.1 | 3.3× faster |
| pure Python loop 10^6 | 16.3 | 169 | 10.4× faster |
| pure Python sieve 10^6 | 7.8 | 13.7 | 1.8× faster |
