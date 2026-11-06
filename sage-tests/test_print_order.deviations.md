# test_print_order: recorded deviations from Sage 10.9
test_print_order.out is Sage 10.9's output (counted-4 on VM2, raw.out sha256 144a28953c90…), except for lines 122-123, which are ours (line 124 was ours too until C0, #754, which prints it as Sage does). Grader accepted counted-4 (9e0193d8) and ruled this deviation set (ecdad2f0). S127 and S146 were observation lines in the probe; here they are ordinary lines, and ours equal Sage's. Sage's three lines, verbatim from raw.out (line 124 is now the .out's line too):

```
S122 1/2*(x + 1)*y || \frac{1}{2} \, {\left(x + 1\right)} y
S123 3/4*a*b + 2/3*(a + b)*c || \frac{3}{4} \, a b + \frac{2}{3} \, {\left(a + b\right)} c
S124 x^2 + (x + 1)*sin(x) || x^{2} + {\left(x + 1\right)} \sin\left(x\right)
```

- Lines 122 and 123, a rational constant times a sum (`1/2*(x + 1)*y`, `2/3*(a + b)*c`): Sage keeps the constant outside the sum. Our engine distributes a numeric coefficient over a sum when it builds the product, so the expression itself is `(1/2*x + 1/2)*y`. This is the expression's structure, not the print order that this test pins, and lane 4p's printer leaves it as it is.
- Line 124, `x^2 + (x + 1)*sin(x)`: was ours (the function-bearing term first) until C0 (#754), whose order of a sum's terms covers terms with function kernels; the .out line is now Sage's.
