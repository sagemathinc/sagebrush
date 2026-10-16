// a tuple holding a part printed over several lines, records, and both in
// Sprint and printf (no indentation there), as Magma lays them out
F := recformat< a, b >;
r := rec< F | a := 3, b := [1, 2] >; r;
s := rec< F | a := r, b := "x" >; s;
t := rec< F | a := [i : i in [1..30]], b := 2 >; t;
<[[5,6],[7,8]], 9>;
<1, [[2]], 3>;
u := <[i : i in [1..30]], [[1],[2]]>; u;
Sprint(r);
Sprint(s);
Sprint(<[[5,6],[7,8]], 9>);
printf "%o\n", [[1],[2]];
printf "%o\n", <[[5,6],[7,8]], 9>;
printf "%o\n", r;
[<[[1],[2]], 3>, <[[4]], 5>];
<[[1],[2]], [[3]]>;
<<[[1],[2]]>, 4>;
r := rec< F | a := <[[1],[2]], 3>, b := 2 >; r;
<rec< F | a := 1, b := 2 >, 5>;
<[i : i in [1..30]], [[1],[2]], [i : i in [1..30]]>;
<"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [[1],[2]], "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">;
[[<[[1]], 2>]];
<[], [[1]]>;
<[[]], 1>;
Sprint(r);
Sprint(<<[[1],[2]]>, 4>);
printf "%o|\n", r;
printf "%o\n", [i : i in [1..40]];
printf "%o\n", <[i : i in [1..30]], [[1],[2]]>;
// a part over several lines: its opening line flows with the tuple's text (CORR-4F1-1)
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
[<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>];
[<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>];
[<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>];
[<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>];
[<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>];
G := recformat< u, w >;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", rec<G | u := 6>, 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", rec<G | u := 6>, 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", rec<G | u := 6>, 8>;
<"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", rec<G | u := 6>, 8>;
// as a record field: structure 4 deeper, continuation 8 (CORR-4F1-2)
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
rec<G | u := rec<G | w := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>>;
rec<G | u := <[[6]], "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", 8>>;
rec<G | u := <10^88, [[6]], 8>>; rec<G | u := <[[6]], 10^88, 8>>;
rec<G | w := rec<G | u := <10^88, [[6]], 8>>>; rec<G | w := rec<G | u := <[[6]], 10^88, 8>>>;
rec<G | u := <[i^2 : i in [1..30]], [[6]], 8>>; rec<G | u := <[[6]], [i^2 : i in [1..30]], 8>>;
rec<G | u := <<10^88, 5>, [[6]], 8>>; rec<G | u := <[[6]], <10^88, 5>, 8>>;
// printf and Sprint lay it out without indentation
printf "%o\n", <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
printf "%o\n", <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
printf "%o\n", <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>;
#Sprint(rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>);
printf "%o\n", rec<G | u := <"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", [[6]], 8>>;
// an empty record in a tuple; printf from the column its text has got to
<rec<G | >, 8>;
printf "abcdefghij%o\n", 10^78;
printf "abc%o|%o\n", [i : i in [1..30]], 10^70;
// an enclosing record's closers are laid out with the last chunk (CORR-4F1-2)
rec<G | w := rec<G | u := <[[6]], [i : i in [1..35]], 8>>>;
rec<G | w := rec<G | u := <[[6]], [i : i in [1..34]], 8>>>;
rec<G | w := rec<G | u := [i : i in [1..36]]>>;
rec<G | w := rec<G | u := "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq">>;
// printf's own text is broken like session output; the value's first chunk is split, not moved
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o|\n", <"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", [[13]], "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww">;
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\n";
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk\n";
printf "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk%o\n", [i : i in [1..20]];
