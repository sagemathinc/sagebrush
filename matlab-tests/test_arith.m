% Arithmetic, operators and their precedence, classes of results.
show(1 + 2 * 3);
show((1 + 2) * 3);
show(2 ^ 3 ^ 2);          % left-associative: 64
show(-2 ^ 2);             % -4: ^ binds tighter than unary minus
show(2 ^ -1);
show(7 / 2);
show(2 \ 7);
show(1 / 0);
show(-1 / 0);
show(0 / 0);
show(mod(-7, 3));
show(rem(-7, 3));
show(mod(7, -3));
show(mod(5, 0));
show(mod(5.5, 2));
show([1 2 3] + [10; 20]);  % implicit expansion
show([1 2 3] .* [4 5 6]);
show([1 2 3] ./ [2 4 8]);
show([1 2 3] .^ 2);
show(2 .^ [1 2 3]);
show([1 2; 3 4] * [5; 6]);
show([1 2; 3 4] ^ 2);
show([1 2; 3 4]');
show([1+2i 3-4i]');
show([1+2i 3-4i].');
show(abs(3 + 4i));
show((1 + 2i) * (3 - 1i));
show(sqrt(-4));
show(round((-8) ^ (1/3) * 1e12) / 1e12);  % (the last bit is the library's)
show(1:5);
show(5:-1:1);
show(0:0.25:1);
show(1:0);
show(size(1:0));
show(10:-3:1);
show(1 == 1);
show([1 2 3] > 2);
show(~[1 0 2]);
show([1 0 1] & [1 1 0]);
show([1 0 1] | [0 0 1]);
show(xor(true, false));
show(true + true);
show('a' + 1);
show(int8(100) + int8(100));
show(int8(-100) - int8(100));
show(int32(7) / int32(2));
show(int32(-7) / int32(2));
show(uint8(5) - 10);
show(int16(5) * 2.6);
show(class(int8(1) + 1));
show(class(single(1) + 1));
show(single(1) / 3);
show(class(true + 1));
show(5 > 3 && 2 > 1);
show(0 || 1);
x = 3;
x = x + 1;
show(x);
show(floor(-2.5));
show(ceil(-2.5));
show(round(-2.5));
show(round(2.5));
show(fix(-2.7));
show(round(0.49999999999999994));
show(sign([-2 0 3]));
show(hypot(3, 4));
show(exp(1));
show(log(100) / log(10));
show(log10(1000));
show(log2(8));
show(pi);
show(eps);
show(realmax);
show(intmax('int8'));
show(intmin('int16'));
show(Inf - Inf);
show(1e308 * 10);
show(factorial(5));
show(nchoosek(5, 2));
show(gcd(12, 18));
show(lcm(4, 6));
% integer to integer conversions saturate, as documented, and cast does the same
cls = {'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64'};
for i = 1:numel(cls)
  v = [intmin(cls{i}) -5 0 5 intmax(cls{i})];
  for j = 1:numel(cls)
    show(feval(cls{j}, v));
  end
end
show(cast(int8([-5 5]), 'uint8'));
show(cast(intmax('uint64'), 'int64'));
show(cast(intmin('int64'), 'uint32'));
