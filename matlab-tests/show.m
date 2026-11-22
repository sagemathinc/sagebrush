function show(x)
% SHOW  A value's class, size and exact contents on one line, printed the
% same by MATLAB, Octave and Sagebrush (their displays differ), so that
% the tests compare values exactly.
fprintf('%s\n', describe(x));
end

function s = describe(x)
if iscell(x)
  parts = cell(1, numel(x));
  for k = 1:numel(x)
    parts{k} = describe(x{k});
  end
  s = sprintf('cell %s {%s}', dimstr(size(x)), strjoin(parts, ', '));
elseif isstruct(x)
  f = fieldnames(x);
  if numel(x) == 1
    parts = cell(1, numel(f));
    for k = 1:numel(f)
      parts{k} = [f{k} '=' describe(x.(f{k}))];
    end
    s = sprintf('struct {%s}', strjoin(parts, ', '));
  else
    parts = cell(1, numel(x));
    for k = 1:numel(x)
      parts{k} = describe(x(k));
    end
    s = sprintf('struct %s [%s]', dimstr(size(x)), strjoin(parts, '; '));
  end
elseif ischar(x)
  if ndims(x) > 2
    s = sprintf('char %s', dimstr(size(x)));
  else
    % (not mat2str: Octave's does not take char arrays)
    rows = cell(1, size(x, 1));
    for k = 1:size(x, 1)
      rows{k} = ['''' strrep(x(k, :), '''', '''''') ''''];
    end
    s = sprintf('char %s [%s]', dimstr(size(x)), strjoin(rows, ';'));
  end
elseif (islogical(x) || isnumeric(x)) && isempty(x)
  % (mat2str of an empty array: MATLAB writes zeros(1,0), Octave [])
  s = sprintf('%s %s []', class(x), dimstr(size(x)));
elseif islogical(x) || isnumeric(x)
  if ndims(x) > 2
    v = reshape(x, size(x, 1), []);
  else
    v = x;
  end
  % (a zero's sign: MATLAB's mat2str drops it and Octave's keeps it, so the zeros are written 0 and the
  % negative ones listed after, by linear index: the same line in all three, the sign still compared)
  m = mat2str(v, 17);
  m = regexprep(m, '(^|[\s;\[])-0(?=$|[\s;\]+-])', '$10');
  m = regexprep(m, '-0i', '+0i');
  s = sprintf('%s %s %s', class(x), dimstr(size(x)), m);
  if isfloat(x)
    nr = find(real(v) == 0 & 1 ./ real(v) < 0);
    ni = [];
    if ~isreal(v)
      ni = find(imag(v) == 0 & 1 ./ imag(v) < 0);
    end
    if ~isempty(nr)
      s = [s sprintf(' (-0 at %s)', strtrim(sprintf('%d ', nr)))];
    end
    if ~isempty(ni)
      s = [s sprintf(' (-0i at %s)', strtrim(sprintf('%d ', ni)))];
    end
  end
else
  s = class(x);
end
end

function s = dimstr(d)
s = sprintf('%dx', d);
s = s(1:end-1);
end
