% polyval, conv and interp1 of single values compute in single at each step,
% so their rounding differs from a double computation rounded once. The
% values are chosen so that the order of the steps shows.
p = single([1 1e-8 -1 1/3]);
show(polyval(p, single(1.0001)))
show(polyval(p, single([0.5 3 -7.25])))
show(polyval(single([3e30 0 0]), single(1e5)))
show(polyval(single([1e8 1 -1e8]), single(1)))
show(polyval(single([1 2]), single(complex(0.1, 0.3))))

a = single([1e8 1 -1e8 1/3]);
b = single([1 1/7 1]);
show(conv(a, b))
show(conv(b, a))
show(conv(single([0.1 0.2 0.3]), single([0.7 0.11])))
show(conv(a, b, 'same'))
show(conv(a, b, 'valid'))
show(conv(single([1e30 1e30]), single([1e10 1e10])))

x = single([0 1 3]);
v = single([1/3 2/3 1e8]);
show(interp1(x, v, single([0.3 0.7 1.9 2.5])))
show(interp1(x, v, single([0.3 1.9]), 'nearest'))
show(interp1(single([0 0.1]), single([0.1 0.3]), single(0.07)))

% orders that tell summations apart
show(conv(single([1 1e8 -1e8]), single([1 1 1])))
show(conv(single([1 1 1]), single([1 1e8 -1e8])))
show(conv(single([1 1e8 -1e8 1 2]), single([1 1 1])))
show(conv(single([1 1e8]), single([1e8 -1e8 1])))
show(interp1(single([0 0.3 1]), single([0.1 1e7 -3.3]), single([0.1 0.2 0.77 0.95])))
show(interp1(single([1 2 4]), single([1/3 1e-3 7/9]), single([1.1 3.3 3.99])))

% linear interpolation on one piece, with values for which five ways of
% writing the formula all round differently in single
c = [-2.60400390625 -0.939483642578125 -6959.96044921875 -5.866499423980713 -1.0563969612121582
     -1.6373958587646484 0.3975331783294678 0.7232871651649475 -2.311978578567505 -1.3024349212646484
     1.3910448551177979 2.465270519256592 -9632.736328125 1.611363410949707 2.2581839561462402
     2.821146011352539 2.8968393802642822 21.085195541381836 -0.34501954913139343 2.877551794052124
     -0.6487638354301453 4.068654537200928 -527213.3125 -3820.53076171875 3.696685552597046
     -2.205686092376709 -0.8509845733642578 122474.890625 -8.990254402160645 -0.943679690361023
     2.292567014694214 3.0445661544799805 -0.008497429080307484 -0.00047531790914945304 2.9081778526306152
     -2.655404567718506 -2.120950698852539 -930.096435546875 105.44962310791016 -2.1597466468811035
     0.9599682688713074 2.9299163818359375 -64743.48046875 -3.5114145278930664 2.6366567611694336
     -2.4775614738464355 1.8049392700195312 4.424781322479248 -0.0932997465133667 0.9077613353729248
     -0.7386461496353149 -0.5325191020965576 1145286.875 0.09938224405050278 -0.5580711960792542
     -1.6890937089920044 0.5277749300003052 -67039.484375 7.250978946685791 0.3675786256790161];
c = single(c);
r = zeros(1, size(c, 1), 'single');
for k = 1:size(c, 1)
  r(k) = interp1(c(k, 1:2), c(k, 3:4), c(k, 5));
end
show(r)

% polyval with centring and scaling: x is normalised once, each step single
% when an operand is
show(polyval(single([1 0]), single(3), [], [1 2]))
show(polyval(single([1 0]), 3, [], [1 3]))
show(polyval([1 0], single(3), [], [1 2]))
show(polyval(single([2 1 -1]), single([0.5 4]), [], single([0.25 4])))

% complex values are interpolated in their real and imaginary parts
% separately, so an Inf or NaN in one part, even one from an overflow in
% single, leaves the other part as it is
show(interp1([0 2], single(complex([0 Inf], [1 2])), [0 0.5 1 2]))
show(interp1([0 2], single(complex([1 2], [NaN 0])), [0.5 1.5]))
show(interp1([0 2], single(complex([-3e38 3e38], [1 2])), 1, 'linear', 'extrap'))
show(interp1([0 1e-10], single(complex([0 3e38], [1 2])), 5e-11, 'linear', 'extrap'))
show(interp1([0 2], single(complex([0 Inf], [1 2])), [-1 3], 'linear', 'extrap'))
show(interp1([0 2], single(complex([0 Inf], [1 2])), [-1 3], 'linear', 7))
show(interp1([0 2], complex([0 Inf], [1 2]), [0 0.5 1 2]))
