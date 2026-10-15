% ode45 and ode23: solutions at given times, to 6 digits with tight
% tolerances (the steps, and so the last digits, depend on the solver)
r6 = @(x) round(x * 1e6) / 1e6 + 0;
o = odeset('RelTol', 1e-10, 'AbsTol', 1e-12);
vdp1 = @(t,y) [y(2); (1-y(1)^2)*y(2)-y(1)];
[t, y] = ode45(vdp1, [0 5 10 20], [2; 0], o); show(r6(t')); show(r6(y));
[t, y] = ode23(vdp1, [0 1 2], [2; 0], o); show(r6(y));
[t, y] = ode45(@(t,y) -y + sin(t), [0 0.5 1 2], 1, o); show(r6(y'));
[t, y] = ode45(@(t,y) [y(2); -y(1)], [0 pi/2 pi], [0 1], o); show(r6(y));
[t, y] = ode23(@(t,y) -2*y + 2*cos(t).*sin(2*t), [0 1 3], -2:2, o); show(r6(y));
[t, y] = ode45(@(t,y) t*y, [1 0.5 0], 1, o); show(r6(y'));
[t, y] = ode45(@(t,y) [y(2); (1/2)*t.*y(1)], [0 2 5], [0 0.01], o); show(r6(y));
% options
o2 = odeset('RelTol', 1e-5); show(odeget(o2, 'RelTol')); show(odeget(o2, 'AbsTol', 7));
o3 = odeset(o2, 'AbsTol', 1e-9); show([o3.RelTol o3.AbsTol]);
o4 = odeset(o2, odeset('RelTol', 1e-3, 'MaxStep', 0.1)); show([o4.RelTol o4.MaxStep]);
