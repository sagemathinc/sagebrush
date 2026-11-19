% Recover a damped vibration's decay, frequency, amplitude and phase.
t = linspace(0, 12, 121)';
y = 1.7 .* exp(-0.18 .* t) .* cos(2.3 .* t + 0.4) + 0.002 .* sin(7 .* t);
model = @(p) p(1) .* exp(-p(2) .* t) .* cos(p(3) .* t + p(4));
loss = @(p) sum((model(p) - y).^2);
options = optimset('MaxIter', 2000, 'TolX', 1e-9, 'TolFun', 1e-12);
[p, fval, exitflag] = fminsearch(loss, [1.5, 0.15, 2.2, 0.3], options);
assert(exitflag > 0);
assert(norm(p - [1.7, 0.18, 2.3, 0.4]) < 0.01);
% Validate the fitted trajectory through an independent state-space ODE.
a = p(2); w = p(3);
rhs = @(s, z) [z(2); -2*a*z(2) - (a*a+w*w)*z(1)];
z0 = [p(1)*cos(p(4)); -p(1)*a*cos(p(4))-p(1)*w*sin(p(4))];
[tode, z] = ode45(rhs, t, z0, odeset('RelTol', 1e-8, 'AbsTol', 1e-10));
validation_error = max(abs(z(:,1) - model(p)));
assert(validation_error < 1e-5);
result = struct('parameters', p, 'sse', fval, 'exitflag', exitflag, 'ode_error', validation_error, 'samples', length(t));
fprintf('{"parameters":[%.16g,%.16g,%.16g,%.16g],"sse":%.16g,"exitflag":%d,"ode_error":%.16g,"samples":%d}\n', p(1), p(2), p(3), p(4), fval, exitflag, validation_error, length(t));
