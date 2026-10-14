% MATLAB's display under each numeric format (format short, long, compact, shortG,
% longG, shortE, longE, rat, bank, hex): each case as the Command Window shows it.
format short; format loose; format short
x = 5
format short; format loose; format short
x = -0
format short; format loose; format short
x = 0.1 + 0.2
format short; format loose; format short
x = 1 - eps
format short; format loose; format short
x = 1/3
format short; format loose; format short
x = -2/3
format short; format loose; format short
x = pi*1e5
format short; format loose; format short
x = pi*1e-5
format short; format loose; format short
x = 123456
format short; format loose; format short
x = 1234567
format short; format loose; format short
x = 100000.5
format short; format loose; format short
x = 1e5
format short; format loose; format short
x = 1e10
format short; format loose; format short
x = 1e-10
format short; format loose; format short
x = [1 2 3]
format short; format loose; format short
x = -[1 2 3]
format short; format loose; format short
x = [1.5 NaN -Inf]
format short; format loose; format short
x = [1 NaN; Inf -Inf]
format short; format loose; format short
x = [1 1e5]
format short; format loose; format short
x = [1 1e6]
format short; format loose; format short
x = [1.5 1e5]
format short; format loose; format short
x = [0.001 1000]
format short; format loose; format short
x = [1e-5 1]
format short; format loose; format short
x = [1e-10; 1]
format short; format loose; format short
x = [1e10 1]
format short; format loose; format short
x = [100000.5 1]
format short; format loose; format short
x = [pi; exp(1)*1e5; -2]
format short; format loose; format short
x = [0.5; 0.25]
format short; format loose; format short
x = [1 -1]*1e-3
format short; format loose; format short
x = [-0 0 1]
format short; format loose; format short
x = (1:12)'*1e4
format short; format loose; format short
x = magic(4)*1000.5
format short; format loose; format short
x = magic(4)/7
format short; format loose; format short
x = -magic(3)/1e4
format short; format loose; format short
x = [1+2i, 3-4.5i]
format short; format loose; format short
x = 1/3 + 1i/7
format short; format loose; format short
x = complex(1, 0)
format short; format loose; format short
x = complex(-0, -0)
format short; format loose; format short
x = [1e5+1i, 1]
format short; format loose; format short
x = [NaN+1i; 2]
format short; format loose; format short
x = 1i*[1 2; 3 4]/3
format short; format loose; format short
x = single(pi)
format short; format loose; format short
x = single([1.5 1e5])
format short; format loose; format short
x = int8([-5 100])
format short; format loose; format short
x = int32(magic(3)) * -1
format short; format loose; format short
x = uint8(200):uint8(205)
format short; format loose; format short
x = intmin('int64')
format short; format loose; format short
x = int64([1 -1000000000000])
format short; format loose; format short
x = true
format short; format loose; format short
x = true(2)
format short; format loose; format short
x = [true false true]
format short; format loose; format short
x = 'abc'
format short; format loose; format short
x = ''
format short; format loose; format short
x = ['ab'; 'cd']
format short; format loose; format short
x = char(zeros(0,3))
format short; format loose; format short
x = "abc"
format short; format loose; format short
x = ["a" "bb"; "ccc" "d"]
format short; format loose; format short
x = {}
format short; format loose; format short
x = cell(2, 3)
format short; format loose; format short
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format short
x = {pi, [1.5 2.25 3], "s", int8(4)}
format short; format loose; format short
x = struct('a', 1, 'b', 'hi')
format short; format loose; format short
x = struct('alpha', [1 2 3], 'b', {{1}}, 'c', struct('d', 1))
format short; format loose; format short
x = struct('a', {1, 2})
format short; format loose; format short
x = struct()
format short; format loose; format short
x = struct('a', {})
format short; format loose; format short
x = []
format short; format loose; format short
x = zeros(0, 3)
format short; format loose; format short
x = zeros(3, 0)
format short; format loose; format short
x = ones(2, 2, 0)
format short; format loose; format short
x = reshape(1:8, 2, 2, 2)
format short; format loose; format short
x = reshape((1:12)*1.5, 2, 3, 2)
format short; format loose; format short
x = @(t) t.^2 + 1
format short; format loose; format short
x = @sin
format short; format loose; format short
x = int8([])
format short; format loose; format short
x = NaN(2, 3)
format short; format loose; format short
x = -Inf
format short; format loose; format short
x = [1e100 1]
format short; format loose; format short
x = realmin
format short; format loose; format short
x = realmax
format short; format loose; format short
x = eps
format short; format loose; format short
x = 3 - 2i
format short; format loose; format short
x = (0:0.1:0.5)'
format short; format loose; format short
x = 1e5*[1 2; 3 4] + 0.5
format short; format loose; format short
x = [1 2; 3 4] == [1 0; 3 0]
format short; format loose; format long
x = 5
format short; format loose; format long
x = 0.1 + 0.2
format short; format loose; format long
x = 1/3
format short; format loose; format long
x = -2/3
format short; format loose; format long
x = pi*1e5
format short; format loose; format long
x = pi*1e-5
format short; format loose; format long
x = 123456
format short; format loose; format long
x = 100000.5
format short; format loose; format long
x = 1e10
format short; format loose; format long
x = 1e-10
format short; format loose; format long
x = [1 2 3]
format short; format loose; format long
x = [1.5 NaN -Inf]
format short; format loose; format long
x = [1 1e5]
format short; format loose; format long
x = [0.001 1000]
format short; format loose; format long
x = [pi; exp(1)*1e5; -2]
format short; format loose; format long
x = 1/3 + 1i/7
format short; format loose; format long
x = single(pi)
format short; format loose; format long
x = int8([-5 100])
format short; format loose; format long
x = true(2)
format short; format loose; format long
x = 'abc'
format short; format loose; format long
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format long
x = struct('a', 1, 'b', 'hi')
format short; format loose; format long
x = reshape(1:8, 2, 2, 2)
format short; format loose; format long
x = realmin
format short; format loose; format long
x = realmax
format short; format loose; format long
x = (0:0.1:0.5)'
format short; format loose; format shortG
x = 5
format short; format loose; format shortG
x = 0.1 + 0.2
format short; format loose; format shortG
x = 1/3
format short; format loose; format shortG
x = -2/3
format short; format loose; format shortG
x = pi*1e5
format short; format loose; format shortG
x = pi*1e-5
format short; format loose; format shortG
x = 123456
format short; format loose; format shortG
x = 100000.5
format short; format loose; format shortG
x = 1e10
format short; format loose; format shortG
x = 1e-10
format short; format loose; format shortG
x = [1 2 3]
format short; format loose; format shortG
x = [1.5 NaN -Inf]
format short; format loose; format shortG
x = [1 1e5]
format short; format loose; format shortG
x = [0.001 1000]
format short; format loose; format shortG
x = [pi; exp(1)*1e5; -2]
format short; format loose; format shortG
x = magic(4)*1000.5
format short; format loose; format shortG
x = magic(4)/7
format short; format loose; format shortG
x = [1+2i, 3-4.5i]
format short; format loose; format shortG
x = 1/3 + 1i/7
format short; format loose; format shortG
x = single(pi)
format short; format loose; format shortG
x = int8([-5 100])
format short; format loose; format shortG
x = true(2)
format short; format loose; format shortG
x = 'abc'
format short; format loose; format shortG
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format shortG
x = struct('a', 1, 'b', 'hi')
format short; format loose; format shortG
x = reshape(1:8, 2, 2, 2)
format short; format loose; format shortG
x = realmin
format short; format loose; format shortG
x = realmax
format short; format loose; format shortG
x = (0:0.1:0.5)'
format short; format loose; format longG
x = 5
format short; format loose; format longG
x = 0.1 + 0.2
format short; format loose; format longG
x = 1/3
format short; format loose; format longG
x = -2/3
format short; format loose; format longG
x = pi*1e5
format short; format loose; format longG
x = pi*1e-5
format short; format loose; format longG
x = 123456
format short; format loose; format longG
x = 100000.5
format short; format loose; format longG
x = 1e10
format short; format loose; format longG
x = 1e-10
format short; format loose; format longG
x = [1 2 3]
format short; format loose; format longG
x = [1.5 NaN -Inf]
format short; format loose; format longG
x = [1 1e5]
format short; format loose; format longG
x = [0.001 1000]
format short; format loose; format longG
x = [pi; exp(1)*1e5; -2]
format short; format loose; format longG
x = (1:20)*pi
format short; format loose; format longG
x = magic(4)*1000.5
format short; format loose; format longG
x = magic(4)/7
format short; format loose; format longG
x = [1+2i, 3-4.5i]
format short; format loose; format longG
x = 1/3 + 1i/7
format short; format loose; format longG
x = single(pi)
format short; format loose; format longG
x = int8([-5 100])
format short; format loose; format longG
x = true(2)
format short; format loose; format longG
x = 'abc'
format short; format loose; format longG
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format longG
x = struct('a', 1, 'b', 'hi')
format short; format loose; format longG
x = reshape(1:8, 2, 2, 2)
format short; format loose; format longG
x = realmin
format short; format loose; format longG
x = realmax
format short; format loose; format longG
x = (0:0.1:0.5)'
format short; format loose; format shortE
x = 5
format short; format loose; format shortE
x = 0.1 + 0.2
format short; format loose; format shortE
x = 1/3
format short; format loose; format shortE
x = -2/3
format short; format loose; format shortE
x = pi*1e5
format short; format loose; format shortE
x = pi*1e-5
format short; format loose; format shortE
x = 123456
format short; format loose; format shortE
x = 100000.5
format short; format loose; format shortE
x = 1e10
format short; format loose; format shortE
x = 1e-10
format short; format loose; format shortE
x = [1 2 3]
format short; format loose; format shortE
x = [1.5 NaN -Inf]
format short; format loose; format shortE
x = [1 1e5]
format short; format loose; format shortE
x = [0.001 1000]
format short; format loose; format shortE
x = [pi; exp(1)*1e5; -2]
format short; format loose; format shortE
x = magic(4)*1000.5
format short; format loose; format shortE
x = magic(4)/7
format short; format loose; format shortE
x = [1+2i, 3-4.5i]
format short; format loose; format shortE
x = 1/3 + 1i/7
format short; format loose; format shortE
x = single(pi)
format short; format loose; format shortE
x = int8([-5 100])
format short; format loose; format shortE
x = true(2)
format short; format loose; format shortE
x = 'abc'
format short; format loose; format shortE
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format shortE
x = struct('a', 1, 'b', 'hi')
format short; format loose; format shortE
x = reshape(1:8, 2, 2, 2)
format short; format loose; format shortE
x = realmin
format short; format loose; format shortE
x = realmax
format short; format loose; format shortE
x = (0:0.1:0.5)'
format short; format loose; format longE
x = 5
format short; format loose; format longE
x = 0.1 + 0.2
format short; format loose; format longE
x = 1/3
format short; format loose; format longE
x = -2/3
format short; format loose; format longE
x = pi*1e5
format short; format loose; format longE
x = pi*1e-5
format short; format loose; format longE
x = 123456
format short; format loose; format longE
x = 100000.5
format short; format loose; format longE
x = 1e10
format short; format loose; format longE
x = 1e-10
format short; format loose; format longE
x = [1 2 3]
format short; format loose; format longE
x = [1.5 NaN -Inf]
format short; format loose; format longE
x = [1 1e5]
format short; format loose; format longE
x = [0.001 1000]
format short; format loose; format longE
x = [pi; exp(1)*1e5; -2]
format short; format loose; format longE
x = (1:20)*pi
format short; format loose; format longE
x = magic(4)*1000.5
format short; format loose; format longE
x = magic(4)/7
format short; format loose; format longE
x = [1+2i, 3-4.5i]
format short; format loose; format longE
x = 1/3 + 1i/7
format short; format loose; format longE
x = single(pi)
format short; format loose; format longE
x = int8([-5 100])
format short; format loose; format longE
x = true(2)
format short; format loose; format longE
x = 'abc'
format short; format loose; format longE
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format longE
x = struct('a', 1, 'b', 'hi')
format short; format loose; format longE
x = reshape(1:8, 2, 2, 2)
format short; format loose; format longE
x = realmin
format short; format loose; format longE
x = realmax
format short; format loose; format longE
x = (0:0.1:0.5)'
format short; format loose; format compact
x = 5
format short; format loose; format compact
x = 0.1 + 0.2
format short; format loose; format compact
x = 1/3
format short; format loose; format compact
x = -2/3
format short; format loose; format compact
x = pi*1e5
format short; format loose; format compact
x = pi*1e-5
format short; format loose; format compact
x = 123456
format short; format loose; format compact
x = 100000.5
format short; format loose; format compact
x = 1e10
format short; format loose; format compact
x = 1e-10
format short; format loose; format compact
x = [1 2 3]
format short; format loose; format compact
x = [1.5 NaN -Inf]
format short; format loose; format compact
x = [1 1e5]
format short; format loose; format compact
x = [0.001 1000]
format short; format loose; format compact
x = [pi; exp(1)*1e5; -2]
format short; format loose; format compact
x = magic(4)*1000.5
format short; format loose; format compact
x = magic(4)/7
format short; format loose; format compact
x = [1+2i, 3-4.5i]
format short; format loose; format compact
x = 1/3 + 1i/7
format short; format loose; format compact
x = single(pi)
format short; format loose; format compact
x = int8([-5 100])
format short; format loose; format compact
x = true(2)
format short; format loose; format compact
x = 'abc'
format short; format loose; format compact
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format compact
x = struct('a', 1, 'b', 'hi')
format short; format loose; format compact
x = reshape(1:8, 2, 2, 2)
format short; format loose; format compact
x = realmin
format short; format loose; format compact
x = realmax
format short; format loose; format compact
x = (0:0.1:0.5)'
format short; format loose; format rat
x = 5
format short; format loose; format rat
x = 0.1 + 0.2
format short; format loose; format rat
x = 1/3
format short; format loose; format rat
x = -2/3
format short; format loose; format rat
x = pi*1e5
format short; format loose; format rat
x = pi*1e-5
format short; format loose; format rat
x = 123456
format short; format loose; format rat
x = 100000.5
format short; format loose; format rat
x = 1e10
format short; format loose; format rat
x = 1e-10
format short; format loose; format rat
x = [1 2 3]
format short; format loose; format rat
x = [1.5 NaN -Inf]
format short; format loose; format rat
x = [1 1e5]
format short; format loose; format rat
x = [0.001 1000]
format short; format loose; format rat
x = [pi; exp(1)*1e5; -2]
format short; format loose; format rat
x = magic(4)*1000.5
format short; format loose; format rat
x = magic(4)/7
format short; format loose; format rat
x = [1+2i, 3-4.5i]
format short; format loose; format rat
x = 1/3 + 1i/7
format short; format loose; format rat
x = single(pi)
format short; format loose; format rat
x = int8([-5 100])
format short; format loose; format rat
x = true(2)
format short; format loose; format rat
x = 'abc'
format short; format loose; format rat
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format rat
x = struct('a', 1, 'b', 'hi')
format short; format loose; format rat
x = reshape(1:8, 2, 2, 2)
format short; format loose; format rat
x = realmin
format short; format loose; format rat
x = realmax
format short; format loose; format rat
x = (0:0.1:0.5)'
format short; format loose; format hex
x = 5
format short; format loose; format hex
x = 0.1 + 0.2
format short; format loose; format hex
x = 1/3
format short; format loose; format hex
x = -2/3
format short; format loose; format hex
x = pi*1e5
format short; format loose; format hex
x = pi*1e-5
format short; format loose; format hex
x = 123456
format short; format loose; format hex
x = 100000.5
format short; format loose; format hex
x = 1e10
format short; format loose; format hex
x = 1e-10
format short; format loose; format hex
x = [1 2 3]
format short; format loose; format hex
x = [1.5 NaN -Inf]
format short; format loose; format hex
x = [1 1e5]
format short; format loose; format hex
x = [0.001 1000]
format short; format loose; format hex
x = [pi; exp(1)*1e5; -2]
format short; format loose; format hex
x = magic(4)*1000.5
format short; format loose; format hex
x = magic(4)/7
format short; format loose; format hex
x = [1+2i, 3-4.5i]
format short; format loose; format hex
x = 1/3 + 1i/7
format short; format loose; format hex
x = single(pi)
format short; format loose; format hex
x = int8([-5 100])
format short; format loose; format hex
x = true(2)
format short; format loose; format hex
x = 'abc'
format short; format loose; format hex
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format hex
x = struct('a', 1, 'b', 'hi')
format short; format loose; format hex
x = reshape(1:8, 2, 2, 2)
format short; format loose; format hex
x = realmin
format short; format loose; format hex
x = realmax
format short; format loose; format hex
x = (0:0.1:0.5)'
format short; format loose; format bank
x = 5
format short; format loose; format bank
x = 0.1 + 0.2
format short; format loose; format bank
x = 1/3
format short; format loose; format bank
x = -2/3
format short; format loose; format bank
x = pi*1e5
format short; format loose; format bank
x = pi*1e-5
format short; format loose; format bank
x = 123456
format short; format loose; format bank
x = 100000.5
format short; format loose; format bank
x = 1e10
format short; format loose; format bank
x = 1e-10
format short; format loose; format bank
x = [1 2 3]
format short; format loose; format bank
x = [1.5 NaN -Inf]
format short; format loose; format bank
x = [1 1e5]
format short; format loose; format bank
x = [0.001 1000]
format short; format loose; format bank
x = [pi; exp(1)*1e5; -2]
format short; format loose; format bank
x = magic(4)*1000.5
format short; format loose; format bank
x = magic(4)/7
format short; format loose; format bank
x = [1+2i, 3-4.5i]
format short; format loose; format bank
x = 1/3 + 1i/7
format short; format loose; format bank
x = single(pi)
format short; format loose; format bank
x = int8([-5 100])
format short; format loose; format bank
x = true(2)
format short; format loose; format bank
x = 'abc'
format short; format loose; format bank
x = {1, 'a'; [1 2 3], {2}}
format short; format loose; format bank
x = struct('a', 1, 'b', 'hi')
format short; format loose; format bank
x = reshape(1:8, 2, 2, 2)
format short; format loose; format bank
x = realmin
format short; format loose; format bank
x = realmax
format short; format loose; format bank
x = (0:0.1:0.5)'
format short; format loose
