% Graphics: the data plotting functions make (get, set, h.Prop), checked
% against Octave's graphics objects (Octave has no h.Prop syntax:
% test_plot_handles.m has it).  The figures are invisible: nothing is drawn.
f = figure('visible', 'off');
show(get(f, 'Number'));
Y = [1 2; 3 4; 5 7];
h = plot(Y);
show(numel(h));
show(get(h(1), 'XData'));
show(get(h(2), 'YData'));
x = [10 20 30];
h = plot(x, [1 2 3; 4 5 6]);
show(numel(h));
show(get(h(2), 'YData'));
show(get(h(1), 'XData'));
h = plot(x, [1 2 3]', 'r--o');
show(get(h, 'LineStyle'));
show(get(h, 'Marker'));
show(get(h, 'Color'));
show(get(h, 'YData'));
set(h, 'LineWidth', 2);
show(get(h, 'LineWidth'));
hold on
h2 = plot([1 2], [3 4], 'k:');
show(numel(get(gca, 'Children')));
show(get(h2, 'Color'));
show(ishold);
hold off
show(ishold);
plot(1:4);
show(numel(get(gca, 'Children')));
title('The title');
xlabel('time');
ylabel('value');
show(get(get(gca, 'Title'), 'String'));
show(get(get(gca, 'XLabel'), 'String'));
axis([0 5 -1 8]);
show(get(gca, 'XLim'));
show(get(gca, 'YLim'));
xlim([1 3]);
show(get(gca, 'XLim'));
show(get(gca, 'XLimMode'));
grid on
show(get(gca, 'XGrid'));
title('Kept');
cla
show(numel(get(gca, 'Children')));
% (cla keeps the axes' properties, and the title; cla reset resets them)
show(get(gca, 'XLimMode'));
show(get(gca, 'XGrid'));
show(get(get(gca, 'Title'), 'String'));
cla reset
show(get(gca, 'XLimMode'));
show(get(gca, 'XGrid'));
% (a new plot with hold off resets the grid; with hold on keeps it)
plot(1:3); grid on; plot(1:4);
show(get(gca, 'XGrid'));
grid on; hold on; plot(1:2);
show(get(gca, 'XGrid'));
hold off
im = imagesc([1 2 3; 4 5 6]);
show(size(get(im, 'CData')));
show(get(im, 'CDataMapping'));
show(get(gca, 'YDir'));
im2 = image(magic(3));
show(get(im2, 'CDataMapping'));
clf
s1 = subplot(2, 1, 1);
plot(1:3, 'DisplayName', 'one');
s2 = subplot(2, 1, 2);
show(numel(get(gcf, 'Children')));
show(isequal(gca, s2));
subplot(2, 1, 1);
show(isequal(gca, s1));
% (scatter's XData: Octave keeps a column, MATLAB the row given)
sc = scatter([1 2 3], [4 5 6]);
show(numel(get(sc, 'XData')));
clf
plot(1:3);
hold on
plot(3:-1:1);
lg = legend('up', 'down');
show(get(lg, 'String'));
show(gray(3));
show(jet(5));
show(hot(4));
show(cool(3));
show(spring(3));
show(summer(3));
show(autumn(3));
show(winter(3));
show(copper(4));
show(bone(4));
show(pink(3));
f2 = figure('visible', 'off');
show(get(f2, 'Number'));
show(get(gcf, 'Number'));
close(f2);
show(get(gcf, 'Number'));
close all
% spy: a marker at each nonzero, rows down (its label and default marker differ: MATLAB's "nz = 5" and '.')
figure('visible', 'off');
spy(sparse([3 2 3 4 1], [1 2 2 3 4], [1 2 3 4 5], 4, 6));
h = get(gca, 'Children');
show(get(gca, 'YDir')); show(get(gca, 'XLim')); show(get(gca, 'YLim')); show(get(h, 'XData')); show(get(h, 'YData')); show(get(h, 'LineStyle'));
spy(speye(3), 'r.', 12);
h = get(gca, 'Children');
show(get(h, 'Color')); show(get(h, 'MarkerSize')); show(get(h, 'Marker'));
