import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// interp3 and slice against MATLAB R2026b: every row below was printed by MATLAB for the same program (the
// makima and interpn rows aside, which Sagebrush doesn't have). Linear and nearest values, the errors, and
// slice's surfaces (their data, order and properties) must match exactly; cubic and spline ones to 1e-12, as
// their sums are rounded in a different order.

const cli = join(__dirname, "..", "src", "cli.js");

function run(lines: string[]): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "sb-interp3-"));
  writeFileSync(join(dir, "main.m"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const id = line.split("|")[0];
    if (line.includes("|") && !got.has(id)) got.set(id, line);
  }
  return got;
}

function close(got: string | undefined, want: string, tol: number) {
  assert.ok(got, want);
  const nums = (s: string) => (s.split("|").slice(1).join(" ").match(/-?[0-9.]+(e[-+]?[0-9]+)?/g) ?? []).map(Number);
  const g = nums(got), w = nums(want);
  assert.equal(g.length, w.length, `${got} vs ${want}`);
  g.forEach((v, i) => assert.ok(Math.abs(v - w[i]) <= tol, `${got} vs ${want}`));
}

const PROGRAM_1 = [
  "[X,Y,Z] = meshgrid(-2:2, -1:1, 0:3); V = X + 10*Z + 0.5*Y.^2 + X.*Y.*Z;",
  "f = figure('Visible','off');",
  "P = @(s, v) fprintf('%s|%s\\n', s, mat2str(v, 17));",
  "% interp3",
  "try, P('i3lin', interp3(X,Y,Z,V, [0.5 -1.25 2], [0.3 -0.7 1], [1.5 0.2 2.9])); catch e, fprintf('i3lin|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3near', interp3(X,Y,Z,V, [0.5 -1.25 2 0.49], [0.3 -0.7 1 0.5], [1.5 0.2 2.9 1.5], 'nearest')); catch e, fprintf('i3near|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3cub', interp3(X,Y,Z,V, [0.5 -1.25], [0.3 -0.7], [1.5 0.2], 'cubic')); catch e, fprintf('i3cub|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3spl', interp3(X,Y,Z,V, [0.5 -1.25], [0.3 -0.7], [1.5 0.2], 'spline')); catch e, fprintf('i3spl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3out', interp3(X,Y,Z,V, [3 0 -2.5], [0 2 0], [1 1 1])); catch e, fprintf('i3out|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3ext', interp3(X,Y,Z,V, [3 0], [0 0], [1 1], 'linear', -7)); catch e, fprintf('i3ext|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3V', interp3(V, [1.5 2], [2.5 1], [3.25 4])); catch e, fprintf('i3V|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3vec', interp3(-2:2, -1:1, 0:3, V, 0.5, 0.3, 1.5)); catch e, fprintf('i3vec|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, [xq,yq,zq] = meshgrid([0 0.5], [-1 1], 1.5); r = interp3(X,Y,Z,V,xq,yq,zq); P('i3grid', r); P('i3gsz', size(r)); catch e, fprintf('i3grid|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, r = interp3(V); P('i3ref', size(r)); P('i3ref1', r(2,2,2)); catch e, fprintf('i3ref|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, r = interp3(V, 2); P('i3ref2', size(r)); catch e, fprintf('i3ref2|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, interp3(Y,X,Z,V, 0, 0, 1); disp('i3ndg|OK'); catch e, fprintf('i3ndg|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, interp3(X,Y,Z,V(:,:,1:3), 0, 0, 1); disp('i3sz|OK'); catch e, fprintf('i3sz|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i3sgl', class(interp3(X,Y,Z,single(V), 0.5, 0.5, 0.5))); catch e, fprintf('i3sgl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "% slice",
  "try",
  "  h = slice(X,Y,Z,V, 0.5, [], []);",
  "  fprintf('offx|%d|%s|%s\\n', numel(h), class(h), mat2str(size(h.XData)));",
  "  P('offxX', h.XData); P('offxY', h.YData); P('offxZ', h.ZData); P('offxC', h.CData);",
  "catch e, fprintf('offx|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try",
  "  h = slice(X,Y,Z,V, [], [], 1.25);",
  "  P('offzX', h.XData); P('offzY', h.YData); P('offzZ', h.ZData); P('offzC', h.CData);",
  "catch e, fprintf('offz|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try",
  "  h = slice(X,Y,Z,V, [-1 1], 0.5, [0 3]);",
  "  fprintf('order|%d|%s\\n', numel(h), mat2str(size(h)));",
  "  for k = 1:numel(h), fprintf('order%d|%s|%s|%s\\n', k, mat2str(h(k).XData(1), 17), mat2str(h(k).YData(1), 17), mat2str(h(k).ZData(1), 17)); end",
  "catch e, fprintf('order|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(X,Y,Z,V, 5, [], []); fprintf('outside|%d|%s\\n', numel(h), mat2str(h.CData, 5)); catch e, fprintf('outside|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(X,Y,Z,V, 0.5, [], [], 'nearest'); P('nearC', h.CData); catch e, fprintf('near|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(X,Y,Z,V, 0.5, [], [], 'cubic'); P('cubC', h.CData); catch e, fprintf('cub|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(V, 2, [], []); P('VX', h.XData); P('VY', h.YData); P('VZ', h.ZData); catch e, fprintf('sV|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try",
  "  [xi, yi] = meshgrid(-1:1, -1:0.5:1); zi = 1 + 0.25*xi + yi.^2;",
  "  h = slice(X,Y,Z,V, xi, yi, zi); fprintf('surfsl|%d\\n', numel(h)); P('surfslC', h.CData); P('surfslZ', h.ZData);",
  "catch e, fprintf('surfsl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(X,Y,Z,V, 0, [], []); fprintf('props|%s|%s|%s|%s|%s\\n', h.Type, h.FaceColor, mat2str(h.EdgeColor, 4), h.CDataMapping, h.FaceLighting); catch e, fprintf('props|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, ax = gca; cla; slice(X,Y,Z,V, 0, [], []); fprintf('view|%s|%d\\n', mat2str(ax.View), ishold); catch e, fprintf('view|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, cla; hold on; slice(X,Y,Z,V, 0, [], []); slice(X,Y,Z,V, [], [], 1); fprintf('hold|%d\\n', numel(findobj(gca, 'Type', 'surface'))); hold off; catch e, fprintf('hold|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, slice(X,Y,Z,V); disp('few|OK'); catch e, fprintf('few|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, slice(X,Y,Z,V, 0, [], [], 'bogus'); disp('meth|OK'); catch e, fprintf('meth|ERR|%s|%s\\n', e.identifier, e.message); end",
  "close(f)",
  ""
];
const EXACT_1 = [
  "i3lin|[15.875 1.2750000000000001 37.299999999999997]",
  "i3near|[21 -0.5 38.5 20.5]",
  "i3out|[NaN NaN NaN]",
  "i3ext|[-7 10]",
  "i3V|[19.5625 32.5]",
  "i3vec|15.875",
  "i3grid|[15.5 15.25;15.5 16.75]",
  "i3gsz|[2 2]",
  "i3ref|[5 9 7]",
  "i3ref1|4.125",
  "i3ref2|[9 17 13]",
  "i3ndg|ERR|MATLAB:interp3:InvalidMeshgrid|Input grid is not a valid MESHGRID.",
  "i3sz|ERR|MATLAB:griddedInterpolant:MixedGridCoordSizeErrId|GridVectors must define a grid whose size is compatible with the Values array.",
  "i3sgl|'single'",
  "offx|1|matlab.graphics.primitive.Surface|[3 4]",
  "offxX|[0.5 0.5 0.5 0.5;0.5 0.5 0.5 0.5;0.5 0.5 0.5 0.5]",
  "offxY|[-1 -1 -1 -1;0 0 0 0;1 1 1 1]",
  "offxZ|[0 1 2 3;0 1 2 3;0 1 2 3]",
  "offxC|[1 10.5 20 29.5;0.5 10.5 20.5 30.5;1 11.5 22 32.5]",
  "offzX|[-2 -1 0 1 2;-2 -1 0 1 2;-2 -1 0 1 2]",
  "offzY|[-1 -1 -1 -1 -1;0 0 0 0 0;1 1 1 1 1]",
  "offzZ|[1.25 1.25 1.25 1.25 1.25;1.25 1.25 1.25 1.25 1.25;1.25 1.25 1.25 1.25 1.25]",
  "offzC|[13.5 13.25 13 12.75 12.5;10.5 11.5 12.5 13.5 14.5;8.5 10.75 13 15.25 17.5]",
  "order|5|[5 1]",
  "order1|-1|-1|0",
  "order2|1|-1|0",
  "order3|-2|0.5|0",
  "order4|-2|-1|0",
  "order5|-2|-1|3",
  "outside|1|[NaN NaN NaN NaN;NaN NaN NaN NaN;NaN NaN NaN NaN]",
  "nearC|[1.5 10.5 19.5 28.5;1 11 21 31;1.5 12.5 23.5 34.5]",
  "cubC|[1 10.5 20 29.5;0.5 10.5 20.5 30.5;1 11.5 22 32.5]",
  "VX|[2 2 2 2;2 2 2 2;2 2 2 2]",
  "VY|[1 1 1 1;2 2 2 2;3 3 3 3]",
  "VZ|[1 2 3 4;1 2 3 4;1 2 3 4]",
  "surfsl|1",
  "surfslC|[18.75 20.5 21.75;9.75 12.75 15.5;6.5 10 13.5;8.75 12.75 17;15.25 20.5 26.25]",
  "surfslZ|[1.75 2 2.25;1 1.25 1.5;0.75 1 1.25;1 1.25 1.5;1.75 2 2.25]",
  "props|surface|flat|[0.1294 0.1294 0.1294]|scaled|flat",
  "view|[-37.5 30]|0",
  "hold|2",
  "few|ERR|MATLAB:hg:shaped_arrays:SurfaceXYDataSize|Value must be a vector or 2D array of numeric type.",
  "meth|ERR|MATLAB:griddedInterpolant:BadInterpTypeErrId|The interpolation method must be 'linear', 'nearest', 'next', 'previous', 'pchip', 'cubic', 'spline', or 'makima'."
];
const CLOSE_1 = [
  "i3cub|[15.769999999999996 1.1700000000000002]",
  "i3spl|[15.77 1.1700000000000004]"
];
const PROGRAM_2 = [
  "[X,Y,Z] = meshgrid(0:4, 0:3, 0:5); V = sin(1.7*X + 0.3) .* cos(0.9*Y - 0.2) + exp(0.31*Z) ./ (1 + X.^2);",
  "xq = mod((1:40) * 0.6180339887498949, 1) * 4; yq = mod((1:40) * 0.7548776662466927, 1) * 3; zq = mod((1:40) * 0.5698402909980532, 1) * 5;",
  "fprintf('lin|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,xq,yq,zq)));",
  "fprintf('cub|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,xq,yq,zq,'cubic')));",
  "fprintf('spl|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,xq,yq,zq,'spline')));",
  "fprintf('near|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,[0.5 1.5 2 3.5],[0.5 1 1.5 2.5],[0.5 2 2.5 4.5],'nearest')));",
  "fprintf('lin2|%s\\n', sprintf('%.17g ', interp2(X(:,:,1),Y(:,:,1),V(:,:,1),xq,yq)));",
  "[Xu,Yu,Zu] = meshgrid([0 0.5 1.5 3 4], [0 1 1.2 3], [0 1 2 3.5 4 5]);",
  "fprintf('linu|%s\\n', sprintf('%.17g ', interp3(Xu,Yu,Zu,V,xq,yq,zq)));",
  "try, fprintf('cubu|%s\\n', sprintf('%.17g ', interp3(Xu,Yu,Zu,V,xq(1:5),yq(1:5),zq(1:5),'cubic'))); catch e, fprintf('cubu|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, fprintf('pchip|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,xq(1:3),yq(1:3),zq(1:3),'pchip'))); catch e, fprintf('pchip|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, fprintf('splx|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,[5 -1],[1 1],[1 1],'spline'))); catch e, fprintf('splx|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, fprintf('cubx|%s\\n', sprintf('%.17g ', interp3(X,Y,Z,V,[4 0],[3 0],[5 0],'cubic'))); catch e, fprintf('cubx|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, fprintf('small|%s\\n', sprintf('%.17g ', interp3(X(1:2,1:2,1:2),Y(1:2,1:2,1:2),Z(1:2,1:2,1:2),V(1:2,1:2,1:2),0.5,0.5,0.5,'cubic'))); catch e, fprintf('small|ERR|%s|%s\\n', e.identifier, e.message); end",
  "f = figure('Visible','off');",
  "try, h = slice(X,Y,Z,V,1.3,[],[],'cubic'); fprintf('slcub|%s\\n', sprintf('%.17g ', h.CData)); catch e, fprintf('slcub|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, h = slice(X,Y,Z,V,1.3,[],[]); fprintf('sllin|%s\\n', sprintf('%.17g ', h.CData)); fprintf('slclass|%s\\n', class(h)); catch e, fprintf('sllin|ERR|%s|%s\\n', e.identifier, e.message); end",
  "close(f)",
  ""
];
const EXACT_2 = [
  "lin|0.52215926009914015 0.96338701787360947 0.13248416046786649 0.006753942123400615 2.9416213413051455 0.0062200682166395913 2.2709310526868425 0.53929449396874429 0.40717171287677434 2.0958721781711769 -0.23699639858194338 1.0637449622343409 1.6155391646501802 0.4964374671466576 1.7311002813239664 0.14893008855831119 0.80168776992904522 1.2253200561286017 -0.19538146167736187 0.92926065273900604 0.0044630610909037888 0.30421780187230762 1.253432697399655 0.00017362925323920544 0.50720155595721172 3.0958812796008486 -0.23383439527472002 2.4526969665322378 0.016781689112426869 0.20439093038241241 2.3463222254868157 -0.3978916027120466 1.0917364117911865 1.7397444780238189 0.27764609830016662 1.9123395161469425 0.13680506670006301 0.63795752322478383 1.4085966687862261 -0.25437166902480202 ",
  "near|1.3771815898916004 -0.033455424545555779 0.52237279773605727 -0.30686358756994314 ",
  "lin2|0.30327248758759373 0.82940606654660154 -0.036447260436457782 -0.12398086454615108 0.67561903184029937 -0.10154013357806069 0.78326124533437003 0.44442607960198038 0.36627105101889051 0.82509160206027721 -0.28600360024420901 0.25448292183746013 0.79085520624452366 -8.3432699407040567e-05 1.0857504973773846 0.13245875728912943 0.41948257113258958 0.84621271196129955 -0.46559696958182129 0.6167815463574986 -0.2138168129886002 0.091306061660417506 1.1432192553204823 -0.16264024501840618 0.3835620608785027 0.89276939624966756 -0.33695988626685197 0.96291500901396487 -0.074921252945125819 0.17262834950141542 1.0956670308618242 -0.44087092732062583 0.28188744783617892 0.96476165492538279 -0.21839000947070694 1.2879788056142121 0.12447581418773868 0.24991135222048105 1.0735503807905182 -0.52478573181360155 ",
  "linu|0.63687851452170552 0.41379953422695581 0.097958689724557721 -0.30187956138269484 2.0295936875906664 0.35716710007616709 1.0014736539802815 0.5271413757614517 0.53412225636664057 0.96706157812608351 -0.23699639858194338 0.17362554580499853 1.3575145786742346 0.75043710453937473 0.76831391012063466 0.14893008855831119 0.77379622350059896 0.50907820486537436 -0.1323387008472782 -0.0082911053930386676 -0.086836644853468911 0.50445518592766114 0.63335112110091496 -0.034755365068288482 0.63404932487491106 2.3721168102330599 0.074838106683123573 1.1460940524823313 -0.023069969666890115 0.40328250466049409 1.1056107990840329 -0.3978916027120466 1.0510914166302139 1.5677348035365954 0.61331762203903883 0.91095720655843404 0.14170023491636852 0.65296539121035524 0.7694732540964806 -0.27854544833063727 ",
  "pchip|0.52215926009914015 0.96338701787360947 0.13248416046786649 ",
  "cubx|-0.30686358756994314 1.2896294776255155 ",
  "small|1.4118586300619524 ",
  "sllin|0.87803800411318578 0.77525601310341075 0.39605555331857517 0.02740797277820442 1.0270423009073786 0.92426030989760366 0.54505985011276803 0.17641226957239733 1.2301985012701859 1.127416510260411 0.74821605047557538 0.37956846993520466 1.5071867669365062 1.4044047759267311 1.0252043161418956 0.65655673560152472 1.8848395246658829 1.7820575336561078 1.402857073871272 1.0342094933309014 2.39974077897539 2.2969587879656146 1.9177583281807791 1.5491107476404085 ",
  "slclass|matlab.graphics.primitive.Surface"
];
const CLOSE_2 = [
  "cub|0.52379563021185982 0.9983142084773422 -0.080556775955812579 -0.059246071348555716 2.7623044272131532 -0.0631661192445227 2.280032770187288 0.38888085633301372 0.42797761707781173 2.0858970645310251 -0.36673148495951108 0.96027443709404525 1.5435819752309563 0.38117108580173042 1.7622528072147881 -0.069471465756276607 0.79543531820334201 1.2269252521068907 -0.22500616576677443 0.97347147870200479 0.022515355415161781 0.23704871878709338 1.3360118506000804 -0.22694105859319083 0.50375711103764609 3.0298486441053973 -0.37550732369472101 2.5165404573759882 0.10281609759211525 0.18536941867594245 2.4383556960498365 -0.52708567285261843 0.99340613913621323 1.7200360131988754 0.067390572899303877 1.9667427081703917 0.26676775949866777 0.6192103040982404 1.5291127134464191 -0.39913079440901333 ",
  "spl|0.55117757978114379 1.0149041111997144 -0.050838163661852065 -0.044886246654579853 2.6691980475215571 -0.076083791746949014 2.2159824002128503 0.42176170301075455 0.46836537156768404 2.1439353574926288 -0.36072584109969286 0.94805810613285169 1.4689730479630845 0.35154699475762691 1.730543860896937 -0.052472688436699388 0.82050211120562333 1.2819408263417069 -0.2267209662640684 0.92591750297442987 0.01981304819094154 0.22137062536109961 1.3964520416817148 -0.21359641179521044 0.50145659618361849 3.0585388230238735 -0.3864744544758123 2.4607639933057137 0.11939168092983965 0.18243191798974004 2.5642984173658405 -0.54689884288018964 0.99614756391523518 1.7201790595506663 0.040136038165916155 2.0027031620836828 0.28251305812925315 0.6187618521312036 1.6626277887846228 -0.44154785509569117 ",
  "cubu|4.1060570126486367 -0.29363676812974149 -0.16360354512388653 -0.93770703038818637 -0.73224192723612491 ",
  "splx|2.8072721578716577 -2.5453229072413168 ",
  "slcub|0.96798985016667538 0.84084263337743581 0.37174991982748712 -0.084288276954839939 1.1093622195640926 0.98221500277485307 0.51312228922490433 0.057084092442577228 1.3021128584449024 1.1749656416556629 0.70587292810571411 0.24983473132338715 1.5649139202600211 1.4377667034707811 0.96867398992083253 0.51263579313850549 1.9232234879593564 1.7960762711701166 1.3269835576201681 0.87094536083784091 2.4117517511944739 2.2846045344052346 1.8155118208552858 1.3594736240729586 "
];

test("interp3 and slice on a small volume: MATLAB R2026b's values, errors and surfaces", () => {
  const got = run(PROGRAM_1);
  for (const want of EXACT_1) assert.equal(got.get(want.split("|")[0]), want);
  for (const want of CLOSE_1) close(got.get(want.split("|")[0]), want, 1e-12);
});

test("interp3 at 40 irregular points (linear to the bit, as MATLAB rounds it), interp2 likewise, and the methods' fallbacks", () => {
  const got = run(PROGRAM_2);
  for (const want of EXACT_2) assert.equal(got.get(want.split("|")[0]), want);
  for (const want of CLOSE_2) close(got.get(want.split("|")[0]), want, 1e-12);
});

const PROGRAM_3 = [
  "[X,Y] = meshgrid(0:4, 0:3); V = sin(1.7*X + 0.3).*cos(0.9*Y - 0.2) + X.*Y/7;",
  "xq = mod((1:25)*0.6180339887498949,1)*4; yq = mod((1:25)*0.7548776662466927,1)*3;",
  "P = @(s, v) fprintf('%s|%s\\n', s, sprintf('%.17g ', v));",
  "try, P('i2lin', interp2(X,Y,V,xq,yq)); catch e, fprintf('i2lin|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2near', interp2(X,Y,V,xq,yq,'nearest')); catch e, fprintf('i2near|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2cub', interp2(X,Y,V,xq,yq,'cubic')); catch e, fprintf('i2cub|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2spl', interp2(X,Y,V,xq,yq,'spline')); catch e, fprintf('i2spl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2out', interp2(X,Y,V,[-1 5 2],[1 1 4])); catch e, fprintf('i2out|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2ext', interp2(X,Y,V,[-1 5 2],[1 1 1],'linear',-3)); catch e, fprintf('i2ext|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, W = V; W(2,3) = NaN; P('i2nan', interp2(X,Y,W,[1.5 2.5 3.5],[0.5 1.5 2.5])); catch e, fprintf('i2nan|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, r = interp2(V); P('i2ref', [size(r) r(2,2) r(4,6)]); catch e, fprintf('i2ref|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, r = interp2(V, 2); P('i2ref2', size(r)); catch e, fprintf('i2ref2|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2Vform', interp2(V, [1.5 3.25], [2.5 1.75])); catch e, fprintf('i2Vform|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, [Xu,Yu] = meshgrid([0 0.5 1.5 3 4],[0 1 1.2 3]); P('i2nonu', interp2(Xu,Yu,V,xq,yq)); catch e, fprintf('i2nonu|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2desc', interp2(4:-1:0, 0:3, V, xq(1:5), yq(1:5))); catch e, fprintf('i2desc|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, r = interp2(X,Y,single(V),xq(1:5),yq(1:5)); fprintf('i2sgl|%s|%s\\n', class(r), sprintf('%.9g ', r)); catch e, fprintf('i2sgl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2vec', interp2(0:4, 0:3, V, xq(1:5), yq(1:5))); catch e, fprintf('i2vec|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, [xg,yg] = meshgrid([0.5 1.5], [0.25 2.75]); r = interp2(X,Y,V,xg,yg); P('i2grid', [size(r) r(:)']); catch e, fprintf('i2grid|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('i2rowcol', size(interp2(0:4, 0:3, V, [0.5 1.5 2.5], [0.5; 1.5]))); catch e, fprintf('i2rowcol|ERR|%s|%s\\n', e.identifier, e.message); end",
  "[X3,Y3,Z3] = meshgrid(1:3,1:4,1:2); V3 = X3 + 10*Y3 + 100*Z3;",
  "try, P('a5shape', interp3(X3(1:2,:,:),Y3,Z3,V3,1.5,2.5,1.5)); catch e, fprintf('a5shape|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('a5shape2', interp3(X3,Y3(:,:,1),Z3,V3,1.5,2.5,1.5)); catch e, fprintf('a5shape2|ERR|%s|%s\\n', e.identifier, e.message); end",
  "try, P('a5shape3', interp3(X3(:,:,1),Y3(:,:,1),Z3(:,:,1),V3,1.5,2.5,1.5)); catch e, fprintf('a5shape3|ERR|%s|%s\\n', e.identifier, e.message); end",
  "[Xs,Ys,Zs] = meshgrid(0:4, 0:3, 0:5); Vs = sin(1.7*Xs + 0.3).*cos(0.9*Ys - 0.2) + exp(0.31*Zs)./(1 + Xs.^2);",
  "xq3 = mod((1:10)*0.6180339887498949,1)*4; yq3 = mod((1:10)*0.7548776662466927,1)*3; zq3 = mod((1:10)*0.5698402909980532,1)*5;",
  "try, r = interp3(single(Xs),single(Ys),single(Zs),Vs,xq3(1:3),yq3(1:3),zq3(1:3)); fprintf('a5sglgrid|%s|%s\\n', class(r), sprintf('%.17g ', r)); catch e, fprintf('a5sglgrid|ERR|%s|%s\\n', e.identifier, e.message); end",
  ""
];
const EXACT_3 = [
  "i2lin|0.95026903466810375 0.50783386788008922 0.26816791358385994 -0.34162625606744534 -0.024338419630630166 0.42430417214222604 0.53365835915988213 0.4395896558716238 0.95647470523666822 0.35542792832332004 0.037557604791617169 -0.0040450406402697536 -0.092234794962750513 0.49655333760558495 0.7602239655805626 0.17415372202171911 0.94543761526917192 0.22100184593543548 -0.13227585398471237 0.30991529570487303 1.1540581642132999 0.55127957933165272 0.70613875368092927 -0.081869609041334709 0.79849255271332809 ",
  "i2near|0.58689953364105774 0.25916323522118467 -0.16247145234666999 -0.51927469343679655 -0.0086290488648892629 0.87970721103089222 0.83832617568265433 0.71443819250838203 0.58689953364105774 0.25916323522118467 -0.16247145234666999 -0.51927469343679655 -0.0086290488648892629 0.87970721103089222 0.83832617568265433 0.71443819250838203 0.58689953364105774 -0.0086290488648892629 -0.16247145234666999 0.89117201734889273 1.1302768218574921 0.58689953364105774 0.83832617568265433 -0.7573606467962376 1.2816176987177217 ",
  "i2out|NaN NaN NaN ",
  "i2ext|-3 -3 -0.11952674720053852 ",
  "i2nan|NaN NaN 1.2590913123106464 ",
  "i2ref|7 9 0.56128849797667146 0.29615213628118536 ",
  "i2ref2|13 17 ",
  "i2Vform|0.32872167082214321 -0.24239623805946775 ",
  "i2nonu|1.3142087632814476 0.40439282992219472 0.26816791358385994 -0.55458923249331893 -0.10676302694929375 1.059990113254033 0.021337489378979106 0.4395896558716238 1.2975692128847847 0.26190187574252372 0.037557604791617169 -0.47158655457524701 -0.15485393994366653 1.0669788489607355 0.27439431311223778 0.17415372202171911 1.2745434548821728 0.083666343283068892 -0.016506392162074959 -0.32908001640652662 1.1727987021045214 1.0675813770614904 0.44349357241673321 -0.081869609041334709 1.2451314892736169 ",
  "i2desc|0.45935709457664997 0.43013071217076565 0.59517449668454381 -0.52113974631700821 1.1556195458170726 ",
  "i2vec|0.95026903466810375 0.50783386788008922 0.26816791358385994 -0.34162625606744534 -0.024338419630630166 ",
  "i2grid|2 2 0.57584462273193782 -0.1699309241036121 0.22931142502730054 0.47389958329071791 ",
  "i2rowcol|2 3 ",
  "a5shape|ERR|MATLAB:griddedInterpolant:BadGridErrId|Grid arrays must have NDGRID structure.",
  "a5shape2|ERR|MATLAB:griddedInterpolant:BadGridErrId|Grid arrays must have NDGRID structure.",
  "a5shape3|ERR|MATLAB:griddedInterpolant:BadGridErrId|Grid arrays must have NDGRID structure.",
  "a5sglgrid|double|0.52215926009914015 0.96338701787360947 0.13248416046786649 "
];
const CLOSE_3 = [
  "i2cub|0.99438169161546952 0.55662844436748582 0.079607953535693152 -0.38813377335720639 -0.092116853904544632 0.36684463255773614 0.64454630241900446 0.3025737221583451 0.99872308804333365 0.4279022204938755 -0.083684507141970205 -0.01810841603703963 -0.13859770907298233 0.44530661635736679 0.81946004855974253 -0.034311290710041228 0.95338509779996594 0.27102541351630904 -0.15664929493777882 0.40027675060147616 1.1838211672940921 0.52762074214938715 0.81234009577132704 -0.28755391838327204 0.82146594063116019 ",
  "i2spl|1.0262200847436724 0.57173946661601238 0.078874049970830584 -0.37202762672486445 -0.1906200373879933 0.35999849316749349 0.58865318739453776 0.31384088331962512 1.0383950299302624 0.48131325515602469 -0.085943690579949522 -0.021527399282964099 -0.21537059905427569 0.43050931985865915 0.78820748852814693 -0.0310437834771502 0.9776838805296173 0.32316257889208366 -0.15525026889438542 0.35654862200819692 1.1617286938880558 0.51402438735499612 0.87029346717837019 -0.29890534402969526 0.82177755676269315 "
];

test("interp2 after its linear rounding change, and interp3's grid checks: MATLAB R2026b's rows; a single V gives single", () => {
  const got = run(PROGRAM_3);
  for (const want of EXACT_3) assert.equal(got.get(want.split("|")[0]), want);
  for (const want of CLOSE_3) close(got.get(want.split("|")[0]), want, 1e-12);
  // (MATLAB's single values are computed in single; Sagebrush's in double, then rounded: only the class is checked)
  assert.match(got.get("i2sgl") ?? "", /^i2sgl\|single\|/);
});

test("the methods Sagebrush lacks are refused with an identifier", () => {
  const got = run([
    "[X,Y,Z] = meshgrid(1:3); V = X + Y + Z;",
    "try, interp3(X,Y,Z,V,1.5,1.5,1.5,'makima'); catch e, fprintf('mak|%s|%s\\n', e.identifier, e.message); end",
    "try, interp3(X,Y,Z,V,1.5,1.5,1.5,'next'); catch e, fprintf('next|%s|%s\\n', e.identifier, e.message); end",
    "try, slice(X,Y,Z,V,2,[],[],'makima'); catch e, fprintf('slmak|%s|%s\\n', e.identifier, e.message); end",
  ]);
  assert.equal(got.get("mak"), "mak|Sagebrush:interp3:unsupportedMethod|interp3: the 'makima' method is not supported in Sagebrush.");
  assert.equal(got.get("next"), "next|Sagebrush:interp3:unsupportedMethod|interp3: the 'next' method is not supported in Sagebrush.");
  assert.equal(got.get("slmak"), "slmak|Sagebrush:slice:unsupportedMethod|slice: the 'makima' method is not supported in Sagebrush.");
});

const PROGRAM_SINGLE = [
  "[X,Y] = meshgrid(0:4, 0:3); V = sin(1.7*X + 0.3).*cos(0.9*Y - 0.2) + X.*Y/7;",
  "xq = mod((1:25)*0.6180339887498949,1)*4; yq = mod((1:25)*0.7548776662466927,1)*3;",
  "P = @(s, v) fprintf('%s|%s\\n', s, sprintf('%.17g ', v));",
  "try, r = interp2(X,Y,single(V),xq(1:5),yq(1:5)); fprintf('i2sgl|%s|%s\\n', class(r), sprintf('%.9g ', r)); catch e, fprintf('i2sgl|ERR|%s|%s\\n', e.identifier, e.message); end",
  "[Xs,Ys,Zs] = meshgrid(0:4, 0:3, 0:5); Vs = sin(1.7*Xs + 0.3).*cos(0.9*Ys - 0.2) + exp(0.31*Zs)./(1 + Xs.^2);",
  "xq3 = mod((1:10)*0.6180339887498949,1)*4; yq3 = mod((1:10)*0.7548776662466927,1)*3; zq3 = mod((1:10)*0.5698402909980532,1)*5;",
  "for m = {'linear','nearest'}",
  "  try, r = interp3(Xs,Ys,Zs,single(Vs),xq3,yq3,zq3,m{1}); fprintf('a5sgl_%s|%s|%s\\n', m{1}, class(r), sprintf('%.9g ', r)); catch e, fprintf('a5sgl_%s|ERR|%s|%s\\n', m{1}, e.identifier, e.message); end",
  "end"
];
const EXACT_SINGLE = [
  "i2sgl|single|0.950269103 0.507833898 0.268167853 -0.341626316 -0.0243384168 ",
  "a5sgl_linear|single|0.522159219 0.963387012 0.132484138 0.00675389543 2.94162154 0.00622008555 2.27093101 0.539294541 0.407171726 2.09587216 ",
  "a5sgl_nearest|single|0.522372782 0.6551615 -0.245481536 -0.246589676 3.44698453 0.208457157 3.0512042 0.86352694 0.288155973 1.24070358 "
];

test("single data: linear and nearest interpolation in single, as MATLAB R2026b computes them, to the bit (#1834)", () => {
  // (t is the double fraction rounded to single, then each step (1 - t) a + t b in single; MATLAB's rows)
  const got = run(PROGRAM_SINGLE);
  for (const want of EXACT_SINGLE) assert.equal(got.get(want.split("|")[0]), want);
});

// (MATLAB R2026b's rows for single queries, a single grid, the implicit grid, a complex single V and more points,
// recorded 2026-11-24: one rule fits every value, each step in single, and a complex V's real and imaginary parts
// each interpolated so)
const PROGRAM_SINGLE_2 = [
  "[X,Y] = meshgrid(0:4, 0:3); V = sin(1.7*X + 0.3).*cos(0.9*Y - 0.2) + X.*Y/7;",
  "xq = mod((1:25)*0.6180339887498949,1)*4; yq = mod((1:25)*0.7548776662466927,1)*3;",
  "r = interp2(X,Y,single(V),single(xq(1:8)),single(yq(1:8))); fprintf('q32|%s|%s\\n', class(r), sprintf('%.9g ', r));",
  "r = interp2(single(X),single(Y),single(V),xq(1:8),yq(1:8)); fprintf('g32|%s|%s\\n', class(r), sprintf('%.9g ', r));",
  "r = interp2(single(V),xq(1:8)+1,yq(1:8)+1); fprintf('impl|%s|%s\\n', class(r), sprintf('%.9g ', r));",
  "r = interp2(X,Y,single(V + 1i*V.'.'),xq(1:8),yq(1:8)); fprintf('cplx|%s|%s\\n', class(r), sprintf('%.9g ', [real(r) imag(r)]));",
  "r = interp2(X,Y,single(V),xq(9:25),yq(9:25)); fprintf('more|%s|%s\\n', class(r), sprintf('%.9g ', r));",
  "[Xs,Ys,Zs] = meshgrid(0:4, 0:3, 0:5); Vs = sin(1.7*Xs + 0.3).*cos(0.9*Ys - 0.2) + exp(0.31*Zs)./(1 + Xs.^2);",
  "W = single(Vs + 1i*cos(Vs)); a = interp3(Xs,Ys,Zs,W,xq(1:10),yq(1:10),mod((1:10)*0.5698402909980532,1)*5);",
  "re = interp3(Xs,Ys,Zs,real(W),xq(1:10),yq(1:10),mod((1:10)*0.5698402909980532,1)*5); im = interp3(Xs,Ys,Zs,imag(W),xq(1:10),yq(1:10),mod((1:10)*0.5698402909980532,1)*5);",
  "fprintf('i3cplx|%s|%d|%d|%d\\n', class(a), isreal(a), isequal(real(a), re), isequal(imag(a), im));",
  "% (an infinite part stays in its own part: the finite one is never touched by it)",
  "Vi = complex(single(ones(4)), single(Inf(4))); Vr = complex(single(Inf(4)), single(ones(4)));",
  "a = interp2(Vi, 2.5, 2.25); b = interp2(Vr, 2.5, 2.25); fprintf('i2inf|%s|%g|%g|%s|%g|%g\\n', class(a), real(a), imag(a), class(b), real(b), imag(b));",
  "Vi3 = complex(single(ones(3,3,3)), single(Inf(3,3,3))); Vr3 = complex(single(Inf(3,3,3)), single(ones(3,3,3)));",
  "a = interp3(Vi3, 1.5, 2.25, 2.5); b = interp3(Vr3, 1.5, 2.25, 2.5); fprintf('i3inf|%s|%g|%g|%s|%g|%g\\n', class(a), real(a), imag(a), class(b), real(b), imag(b));",
];
const EXACT_SINGLE_2 = [
  "q32|single|0.950269043 0.507833898 0.268167824 -0.341626316 -0.0243383981 0.424304157 0.533658385 0.439589739 ",
  "g32|single|0.950269103 0.507833898 0.268167853 -0.341626316 -0.0243384168 0.424304187 0.533658326 0.43958962 ",
  "impl|single|0.950269103 0.507833898 0.268167853 -0.341626316 -0.0243384168 0.424304187 0.533658326 0.43958962 ",
  "cplx|single|0.950269103 0.507833898 0.268167853 -0.341626316 -0.0243384168 0.424304187 0.533658326 0.43958962 0.950269103 0.507833898 0.268167853 -0.341626316 -0.0243384168 0.424304187 0.533658326 0.43958962 ",
  "more|single|0.956474662 0.355427921 0.0375576168 -0.00404506549 -0.0922347903 0.496553332 0.760223925 0.174153686 0.94543761 0.221001834 -0.132275864 0.309915304 1.15405822 0.551279545 0.70613873 -0.0818696022 0.798492491 ",
  "i3cplx|single|0|1|1",
  "i2inf|single|1|Inf|single|Inf|1",
  "i3inf|single|1|Inf|single|Inf|1",
];

test("single data, complex single data and single queries: MATLAB R2026b's rows to the bit, and interp3's complex parts", () => {
  const got = run(PROGRAM_SINGLE_2);
  for (const want of EXACT_SINGLE_2) assert.equal(got.get(want.split("|")[0]), want);
});

test("query coordinates of single and double mixed: MATLAB R2026b's error, for interp3 and interp2 (#1835)", () => {
  const got = run([
    "[X,Y,Z] = meshgrid(0:4, 0:3, 0:5); V = X + Y + Z;",
    "try, r = interp3(X,Y,Z,V,single([0.5 1.5]),[1 2],[1 2]); fprintf('a5sglq|%s\\n', class(r)); catch e, fprintf('a5sglq|ERR|%s|%s\\n', e.identifier, e.message); end",
    "try, r = interp2(X(:,:,1),Y(:,:,1),V(:,:,1),[0.5 1.5],single([1 2])); fprintf('i2q|%s\\n', class(r)); catch e, fprintf('i2q|ERR|%s|%s\\n', e.identifier, e.message); end",
    "r = interp3(X,Y,Z,V,single([0.5 1.5]),single([1 2]),single([1 2])); fprintf('a5sq|%s\\n', class(r));",
  ]);
  const err = "ERR|MATLAB:griddedInterpolant:QueryOfMixedDataTypesErrId|All query coordinates must have the same type. Query coordinates must be of type double or single.";
  assert.equal(got.get("a5sglq"), `a5sglq|${err}`);
  assert.equal(got.get("i2q"), `i2q|${err}`);
  assert.equal(got.get("a5sq"), "a5sq|double");
});
