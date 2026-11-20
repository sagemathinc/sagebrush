% Identical MATLAB syntax run in Sagebrush and GNU Octave.
% Deterministic noise, no PRNG or external files required.
t = (0:0.025:10)';
truth = [2.4, 0.18, 4.7, 0.65];
noise = 0.025*sin(17.3*t+0.2) + 0.020*cos(29.1*t-0.7) + 0.010*sin(43*t+1.1);
clean = truth(1)*exp(-truth(2)*t).*cos(truth(3)*t+truth(4));
x = clean + noise;
% Positive A, beta, omega by logarithmic coordinates; phase unconstrained.
model = @(q) exp(q(1))*exp(-exp(q(2))*t).*cos(exp(q(3))*t+q(4));
loss = @(q) sum((model(q)-x).^2);
opts = optimset('Display','off','TolX',1e-9,'TolFun',1e-12,'MaxIter',1800,'MaxFunEvals',5000);
seeds = [4.2 4.7 5.2];
bestloss = Inf;
flags = zeros(1,3);
losses = zeros(1,3);
for k = 1:3
    q0 = [log(2), log(0.2), log(seeds(k)), 0.3];
    [q, value, flag, info] = fminsearch(loss,q0,opts);
    flags(k) = flag;
    losses(k) = value;
    if value < bestloss
        bestq = q;
        bestloss = value;
    end
end
A = exp(bestq(1));
beta = exp(bestq(2));
omega = exp(bestq(3));
phi = mod(bestq(4)+pi,2*pi)-pi;
fitted = A*exp(-beta*t).*cos(omega*t+phi);
residual = fitted-x;
rmse = sqrt(mean(residual.^2));
% Independent IVP validation: no use of the fitted analytic formula in RHS.
y0 = [A*cos(phi); -beta*A*cos(phi)-omega*A*sin(phi)];
rhs = @(s,y) [y(2); -2*beta*y(2)-(beta^2+omega^2)*y(1)];
odeopts = odeset('RelTol',1e-9,'AbsTol',1e-11);
[tode,yode] = ode45(rhs,t,y0,odeopts);
ode_error = max(abs(yode(:,1)-fitted));
truth_error = max(abs(fitted-clean));
% Prefix allows choosing separate output destinations with a CLI setup cell.
if ~exist('prefix','var')
    prefix = 'evidence/sagebrush';
end
fid = fopen([prefix '-trajectory.csv'],'w');
fprintf(fid,'t,observed,clean,fitted,ode,residual\n');
fprintf(fid,'%.17g,%.17g,%.17g,%.17g,%.17g,%.17g\n',[t x clean fitted yode(:,1) residual]');
fclose(fid);
fid = fopen([prefix '-result.json'],'w');
fprintf(fid,'{"schema":"oscillator-fit-v1","n":%d,"amplitude":%.17g,"decay_rate":%.17g,"angular_frequency":%.17g,"phase":%.17g,"sse":%.17g,"rmse":%.17g,"ode_max_abs_error":%.17g,"clean_max_abs_error":%.17g,"start_losses":[%.17g,%.17g,%.17g],"exitflags":[%d,%d,%d]}\n',length(t),A,beta,omega,phi,bestloss,rmse,ode_error,truth_error,losses(1),losses(2),losses(3),flags(1),flags(2),flags(3));
fclose(fid);
fprintf('FIT A=%.12g beta=%.12g omega=%.12g phi=%.12g RMSE=%.12g ODE_error=%.12g\n',A,beta,omega,phi,rmse,ode_error);
assert(all(flags > 0));
assert(rmse < 0.03);
assert(ode_error < 1e-6);
assert(abs(A-truth(1)) < 0.02);
assert(abs(beta-truth(2)) < 0.01);
assert(abs(omega-truth(3)) < 0.01);
assert(abs(phi-truth(4)) < 0.02);
