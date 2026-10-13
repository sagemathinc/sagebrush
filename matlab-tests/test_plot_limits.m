% Graphics: automatic axis limits (2-D and 3-D), contour matrices, and the
% 3-D plotting functions' data, checked against Octave.  Invisible: nothing drawn.
f = figure('visible', 'off');
plot(1:10);
show([get(gca, 'XLim') get(gca, 'YLim')]);
plot(sin(0:0.1:2*pi));
show([get(gca, 'XLim') get(gca, 'YLim')]);
plot([0.3 2.7], [13 87]);
show([get(gca, 'XLim') get(gca, 'YLim')]);
plot(linspace(0, 1, 50), exp(linspace(0, 1, 50)));
show([get(gca, 'XLim') get(gca, 'YLim')]);
plot([-3.2 4.1], [0.001 0.0047]);
show([get(gca, 'XLim') get(gca, 'YLim')]);
bar([3 9 4]);
show([get(gca, 'XLim') get(gca, 'YLim')]);
x = 0:0.01:1;
plot(x, x.^2*1000);
show([get(gca, 'XLim') get(gca, 'YLim')]);
% 3-D: a surface's limits round outward, and the view turns
surf(peaks);
show([get(gca, 'XLim') get(gca, 'YLim') get(gca, 'ZLim')]);
show(get(gca, 'View'));
[x, y, z] = sphere;
surf(x, y, z);
show([get(gca, 'XLim') get(gca, 'YLim') get(gca, 'ZLim')]);
show(size(x));
mesh(peaks(20));
show([get(gca, 'XLim') get(gca, 'YLim') get(gca, 'ZLim')]);
t = 0:0.1:10;
plot3(sin(t), cos(t), t);
show([get(gca, 'XLim') get(gca, 'YLim') get(gca, 'ZLim')]);
show(get(gca, 'View'));
h = scatter3([1 2 3], [4 5 6], [7 8 9]);
show(numel(get(h, 'ZData')));
show(get(gca, 'View'));
% hold on keeps a 2-D view
plot(1:3);
hold on
surf(peaks(5));
show(get(gca, 'View'));
hold off
% contour matrices: a closed line repeats its first point
C = contourc([0 0 0; 0 1 0; 0 0 0], [0.5 0.5]);
show(C);
C = contourc(1:4, 1:3, [1 2 3 4; 2 3 4 5; 3 4 5 6], [3.5 3.5]);
show(C(:, 1));
show(sortrows(C(:, 2:end)')');
[C, h] = contour(peaks(10), [0 0]);
show(C(1, 1));
show(get(h, 'LevelList'));
pcolor(magic(4));
show(numel(findobj(gca, 'Type', 'surface')));
show(get(gca, 'View'));
close all
