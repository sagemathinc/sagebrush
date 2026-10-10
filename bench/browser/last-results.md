| benchmark (ms: best, median) | sagebrush | Pyodide 314.0.7 (NumPy 2.4.6) | ratio of best | answers |
|---|---:|---:|---:|---|
| startup: navigation to `import numpy` done (fresh profile, cache disabled) | 643 | 3235 | 5.0× | |
| rand(1000,1000) | 8.1, 8.2 | 16.6, 16.8 | 2.0× faster | agree |
| randn(10^6) | 24.6, 24.7 | 39, 39.1 | 1.6× faster | agree |
| sin (10^6, 2-D) | 14.9, 15 | 9.3, 9.5 | 1.6× slower | agree |
| exp (10^6) | 7.5, 7.9 | 7.2, 7.3 | 1.0× slower | agree |
| sqrt (10^6) | 6.7, 6.9 | 2.7, 2.8 | 2.5× slower | agree |
| a*2+1 (10^6, 2-D) | 6.3, 6.5 | 1.1, 1.3 | 5.7× slower | agree |
| a+a.T (10^6) | 7.1, 9.9 | 1.4, 1.5 | 5.1× slower | agree |
| outer broadcast 1000x1000 | 6, 8.8 | 1, 1.1 | 6.0× slower | agree |
| sum (10^6) | 0.8, 0.9 | 0.4, 0.4 | 2.0× slower | agree |
| mean+std (10^6) | 3.3, 4.1 | 2.2, 2.3 | 1.5× slower | agree |
| sum(axis=0) 1000x1000 | 1.3, 3 | 0.5, 0.6 | 2.6× slower | agree |
| a[a>0.5] | 15.1, 17.2 | 9.1, 9.4 | 1.7× slower | agree |
| sort 10^6 | 27.2, 28.2 | 128.9, 129.2 | 4.7× faster | agree |
| argsort 10^5 ints | 2.3, 2.4 | 5.5, 5.8 | 2.4× faster | agree |
| unique 10^5 ints | 3, 3.1 | 1.4, 1.6 | 2.1× slower | agree |
| cumsum 10^6 | 4.9, 5 | 3.7, 3.8 | 1.3× slower | agree |
| matmul 300x300 | 3.4, 3.7 | 25.1, 25.2 | 7.4× faster | agree |
| inv 200x200 | 4.3, 4.4 | 5.2, 5.4 | 1.2× faster | agree |
| det 1000x1000 | 122.4, 124 | 180.4, 180.7 | 1.5× faster | agree |
| solve 200x200 | 2.3, 2.7 | 1.6, 1.8 | 1.4× slower | agree |
| eigh 200x200 | 11.6, 11.8 | 14.2, 15.9 | 1.2× faster | agree |
| svd 200x200 | 22.9, 26.5 | 27.5, 29 | 1.2× faster | agree |
| eig 100x100 | 5.9, 16 | 9.2, 9.6 | 1.6× faster | agree |
| fft 2^16 | 4.6, 4.8 | 2, 2.4 | 2.3× slower | agree |
| rfft 10^6 | 36.8, 43.2 | 14.9, 18.7 | 2.5× slower | agree |
| polyfit deg 5, 10^5 pts | 67.1, 83 | 14.7, 15.2 | 4.6× slower | agree |
| histogram 10^6 | 62, 63.1 | 40.4, 43.3 | 1.5× slower | agree |
| python loop a[i] 10^4 | 10.6, 13.4 | 3.4, 3.6 | 3.1× slower | agree |
| tolist 10^6 | 13.6, 14.8 | 20.4, 39.8 | 1.5× faster | agree |
| pure Python loop 10^6 | 16.8, 16.9 | 164.9, 165.7 | 9.8× faster | agree |
| pure Python sieve 10^6 | 7.7, 8.3 | 13, 13.2 | 1.7× faster | agree |

Times from performance.now / time.perf_counter (about 0.1 ms resolution in the browser: sub-millisecond rows are imprecise). Answers are compared by a digest (shape and the sum of absolute values to 6 digits) computed outside the timers; 0 differ.
