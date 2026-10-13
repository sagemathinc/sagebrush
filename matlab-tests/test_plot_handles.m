% MATLAB's dot syntax on graphics handles (Octave has none: its handles are
% numbers), with the output MATLAB gives, by hand.
figure('visible', 'off');
h = plot(1:3, [4 5 6], 'r');
h.MarkerSize = 9;
fprintf('%g\n', h.MarkerSize);
h.LineStyle = '--';
fprintf('%s\n', get(h, 'LineStyle'));
ax = gca;
ax.YLim = [2 6];
fprintf('%g %g\n', ax.YLim);
xlabel('time');
fprintf('%s\n', ax.XLabel.String);
ax.Title.String = 'T';
fprintf('%s\n', get(get(gca, 'Title'), 'String'));
g = h;
g.LineWidth = 3;
fprintf('%g\n', h.LineWidth);
fprintf('%s\n', class(h));
fprintf('%s\n', class(ax));
fprintf('%d\n', isgraphics(h));
delete(h);
fprintf('%d\n', isgraphics(h));
fprintf('%d\n', numel(ax.Children));
close all
