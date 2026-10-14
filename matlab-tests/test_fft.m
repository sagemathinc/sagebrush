% fft, ifft, fft2, ifft2, fftn, ifftn, fftshift and ifftshift.  (Values to
% 10 significant digits: the last bits depend on the FFT library.)
show(r(fft([1 2 3 4])));
show(r(fft(1:7)));
show(r(fft([1 2 3]')));
show(r(fft([1 2 3], 5)));
show(r(fft([1 2 3 4 5], 3)));
show(r(fft(magic(3))));
show(r(fft(magic(3), [], 2)));
show(r(fft(magic(3), 4, 1)));
show(r(fft([1+2i, 3-1i, 0.5])));
show(r(fft(5)));
show(r(ifft([1 2 3])));
show(r(ifft(fft([1 2 3 4]))));
show(isreal(ifft(fft([1 2 3 4]))));
show(isreal(ifft([1 2 3])));
show(r(ifft(fft(magic(4)))));
show(r(ifft(fft([1 2 3], 6))));
show(r(fft2(magic(3))));
show(r(fft2([1 2; 3 4], 3, 3)));
show(r(real(ifft2(fft2(magic(4))))));
show(r(fftn(reshape(1:8, 2, 2, 2))));
show(r(real(ifftn(fftn(reshape(1:8, 2, 2, 2))))));
show(fftshift(1:5)); show(fftshift(1:6)); show(ifftshift(1:5)); show(ifftshift(1:6));
show(fftshift(magic(4))); show(fftshift(magic(4), 1)); show(fftshift(magic(4), 2)); show(ifftshift(magic(3)));
show(ifftshift(fftshift(1:7)));
show(size(fft(zeros(0, 3))));
show(r(abs(fft(sin(2 * pi * 5 * (0:63) / 64)))));

function y = r(x)
% (each part rounded, and no -0 from rounding noise)
if isreal(x)
  y = round(x * 1e10) / 1e10 + 0;
else
  y = complex(round(real(x) * 1e10) / 1e10 + 0, round(imag(x) * 1e10) / 1e10 + 0);
end
end
