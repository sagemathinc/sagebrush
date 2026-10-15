// In a file, a statement Magma rejects before running it is reported and
// the next statement runs (unlike a runtime error, which stops the file).
F := recformat< a, b, a >; 1;
2;
s := [7, 8]; assigned s[1]; 3;
delete s[1];
4;
s;
