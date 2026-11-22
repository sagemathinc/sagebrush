import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB's hamming, hann, freqz, pwelch and spectrogram in MATLAB mode (lib/_matlab_signal.py), against the rows
// an observed MATLAB R2026b run printed for the same script (values only, 2026-11-22): sizes, windows, frequency
// grids and segment times exactly; the spectra, which are sums of an FFT, within 1e-13 of each row's largest
// element (MATLAB's FFT rounds in its own order). And the error MATLAB gives for too short a signal.

const cli = join(__dirname, "..", "src", "cli.js");

function run(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "sb-signal-"));
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

// (name|size|values: the probe prints each row so)
const SCRIPT = [
  "fmt = @(v) sprintf('%.17g ', v);",
  "p = @(name, v) fprintf('%s|%s|%s\\n', name, mat2str(size(v)), fmt(v(:)'));",
  "b = [1 2 1]/4; a = [1 -0.5 0.25];",
  "[h, w] = freqz(b, a, 8);            p('fz8_h_re', real(h)); p('fz8_h_im', imag(h)); p('fz8_w', w);",
  "[h, w] = freqz(b, a, 5, 'whole');   p('fz5w_h_re', real(h)); p('fz5w_h_im', imag(h)); p('fz5w_w', w);",
  "[h, f] = freqz(b, a, 6, 1000);      p('fz6fs_h_re', real(h)); p('fz6fs_f', f);",
  "[h, w] = freqz(b, a);               p('fzdef_size', size(h)); p('fzdef_w_last', w(end)); p('fzdef_h_10', [real(h(10)) imag(h(10))]);",
  "h = freqz(b, a, [0 pi/4 pi/2]);     p('fzvec_h_re', real(h)); p('fzvec_h_im', imag(h));",
  "h = freqz(b, a, [0 100 250], 1000); p('fzvecfs_h_re', real(h)); p('fzvecfs_h_im', imag(h));",
  "[h, w] = freqz([1 1], 1, 4);        p('fzfir_h_re', real(h)); p('fzfir_h_im', imag(h));",
  "h = freqz(b, a, 8); p('fz_isrow', isrow(h));",
  "[h, w] = freqz(b', a', 4);          p('fzcol_h_re', real(h));",
  "x = sin(2*pi*0.1*(0:99)') + 0.5*cos(2*pi*0.27*(0:99)');",
  "[pxx, w] = pwelch(x);               p('pw_size', size(pxx)); p('pw_w2', w(1:3)); p('pw_first5', pxx(1:5)); p('pw_last3', pxx(end-2:end)); p('pw_sum', sum(pxx));",
  "[pxx, w] = pwelch(x, 20);           p('pw20_size', size(pxx)); p('pw20_first5', pxx(1:5)); p('pw20_sum', sum(pxx));",
  "[pxx, w] = pwelch(x, 20, 10, 32);   p('pw20_10_32', pxx); p('pw20_10_32_w', w);",
  "[pxx, f] = pwelch(x, 20, 10, 32, 50); p('pwfs', pxx); p('pwfs_f', f);",
  "[pxx, f] = pwelch(x, hann(16), 8, 16, 1, 'twosided'); p('pwtwo', pxx); p('pwtwo_f', f);",
  "[pxx, f] = pwelch(x, 16, 4, 16, 'centered'); p('pwcen', pxx); p('pwcen_f', f);",
  "[pxx, w] = pwelch(x, 21, 0, 21);    p('pwodd', pxx); p('pwodd_w', w);",
  "X = [x, 2*x];  pxx = pwelch(X, 20, 10, 32); p('pwmat_size', size(pxx)); p('pwmat_ratio', pxx(:,2)./pxx(:,1));",
  "try, pwelch(x(1:7)); catch e, fprintf('line25|ERR|%s %s\\n', e.identifier, e.message); end",
  "[s, w, t] = spectrogram(x);         p('sg_size', size(s)); p('sg_t', t); p('sg_w3', w(1:3)); p('sg_s11', [real(s(1,1)) imag(s(1,1))]); p('sg_s52', [real(s(5,2)) imag(s(5,2))]);",
  "[s, w, t] = spectrogram(x, 20, 10, 32); p('sg20_size', size(s)); p('sg20_t', t); p('sg20_col1_re', real(s(:,1))); p('sg20_col1_im', imag(s(:,1)));",
  "[s, f, t] = spectrogram(x, 20, 10, 32, 50); p('sgfs_f', f); p('sgfs_t', t);",
  "[s, f, t, ps] = spectrogram(x, 20, 10, 32, 50); p('sgps_col1', ps(:,1)); p('sgps_size', size(ps));",
  "[s, f, t] = spectrogram(x, hann(16), 8, 16, 1, 'twosided'); p('sgtwo_size', size(s)); p('sgtwo_t', t);",
  "[s, f, t] = spectrogram(x, 21, 5, 21); p('sgodd_size', size(s)); p('sgodd_t', t); p('sgodd_f', f);",
  "[s, w, t] = spectrogram(x, 16, 8, [0.1 0.2 0.3]); p('sgvecf_size', size(s)); p('sgvecf_re', real(s(:,1)));",
  "p('hamming5', hamming(5)); p('hann5', hann(5));"
].join("\n");

// MATLAB R2026b's rows: [size, values]
const MATLAB: Record<string, [string, string]> = {
  "fz8_h_re": [
    "[8 1]",
    "1.3333333333333333 1.2322394282419415 0.76447132802172579 -0.031137788503509164 -0.30769230769230771 -0.2101001650290972 -0.092272157897244592 -0.022327587973531866"
  ],
  "fz8_h_im": [
    "[8 1]",
    "0 -0.54007562956477495 -1.0561073083016506 -0.99676446600405533 -0.46153846153846156 -0.1488013423213104 -0.035360420334845814 -0.0038724360301590289"
  ],
  "fz8_w": [
    "[8 1]",
    "0 0.39269908169872414 0.78539816339744828 1.1780972450961724 1.5707963267948966 1.9634954084936207 2.3561944901923448 2.748893571891069"
  ],
  "fz5w_h_re": [
    "[5 1]",
    "1.3333333333333333 -0.14267499957514704 -0.058231344835729053 -0.058231344835729053 -0.14267499957514704"
  ],
  "fz5w_h_im": [
    "[5 1]",
    "0 -0.89483956125310837 -0.016986126352985326 0.016986126352985326 0.89483956125310837"
  ],
  "fz5w_w": [
    "[5 1]",
    "0 1.2566370614359172 2.5132741228718345 3.7699111843077517 5.026548245743669"
  ],
  "fz6fs_h_re": [
    "[6 1]",
    "1.3333333333333333 1.1323864271771584 0.2142857142857143 -0.30769230769230771 -0.16666666666666666 -0.04007873486946615"
  ],
  "fz6fs_f": [
    "[6 1]",
    "0 83.333333333333343 166.66666666666669 250 333.33333333333337 416.66666666666669"
  ],
  "fzdef_size": [
    "[1 2]",
    "512 1"
  ],
  "fzdef_w_last": [
    "[1 1]",
    "3.1354567304382504"
  ],
  "fzdef_h_10": [
    "[1 2]",
    "1.331633158953708 -0.073687034169907573"
  ],
  "fzvec_h_re": [
    "[1 3]",
    "1.3333333333333333 0.76447132802172613 -0.30769230769230765"
  ],
  "fzvec_h_im": [
    "[1 3]",
    "0 -1.0561073083016508 -0.46153846153846156"
  ],
  "fzvecfs_h_re": [
    "[1 3]",
    "1.3333333333333333 1.0147276294660008 -0.30769230769230765"
  ],
  "fzvecfs_h_im": [
    "[1 3]",
    "0 -0.87493959013408007 -0.46153846153846156"
  ],
  "fzfir_h_re": [
    "[4 1]",
    "2 1.7071067811865475 1 0.29289321881345243"
  ],
  "fzfir_h_im": [
    "[4 1]",
    "0 -0.70710678118654757 -1 -0.70710678118654757"
  ],
  "fz_isrow": [
    "[1 1]",
    "0"
  ],
  "fzcol_h_re": [
    "[4 1]",
    "1.3333333333333333 0.76447132802172579 -0.30769230769230771 -0.092272157897244592"
  ],
  "pw_size": [
    "[1 2]",
    "129 1"
  ],
  "pw_w2": [
    "[3 1]",
    "0 0.024543692606170259 0.049087385212340517"
  ],
  "pw_first5": [
    "[5 1]",
    "3.4285725660978275e-06 5.233561119775268e-05 0.00023236564402147566 0.00068866054273099503 0.0016918623105366219"
  ],
  "pw_last3": [
    "[3 1]",
    "8.8529232668370633e-05 6.7930034485623933e-05 3.0174913243199572e-05"
  ],
  "pw_sum": [
    "[1 1]",
    "25.469154362091274"
  ],
  "pw20_size": [
    "[1 2]",
    "129 1"
  ],
  "pw20_first5": [
    "[5 1]",
    "7.5880368660539703e-05 0.00045719912147139895 0.0014534202688103557 0.0033853614481727718 0.0066764968451511128"
  ],
  "pw20_sum": [
    "[1 1]",
    "25.474727742143802"
  ],
  "pw20_10_32": [
    "[17 1]",
    "7.5880368660539703e-05 0.048771388892624348 0.48437268936910088 1.100233157967488 0.75784806303387775 0.15163742097166777 0.0064297882868772195 0.053931747732348476 0.22161547430234543 0.26053273868699017 0.091809242583850217 0.0069167148727666081 4.8748649841986898e-05 2.8746573978760052e-05 3.4809257059928985e-05 3.6532162720246913e-05 1.7824055776688085e-05"
  ],
  "pw20_10_32_w": [
    "[17 1]",
    "0 0.19634954084936207 0.39269908169872414 0.58904862254808621 0.78539816339744828 0.98174770424681035 1.1780972450961724 1.3744467859455345 1.5707963267948966 1.7671458676442586 1.9634954084936207 2.1598449493429825 2.3561944901923448 2.5525440310417071 2.748893571891069 2.9452431127404308 3.1415926535897931"
  ],
  "pwfs": [
    "[17 1]",
    "9.5354083494254688e-06 0.0061287934820175791 0.060868067300859925 0.13825937625226234 0.09523399629457939 0.019055320309355771 0.00080799102584764692 0.0067772632988481584 0.027849021839602642 0.032739509515147106 0.011537089681322681 0.00086918002525035345 6.1259360086402902e-06 3.6124010251019236e-06 4.374260250255661e-06 4.5907669608669845e-06 2.2398369074087199e-06"
  ],
  "pwfs_f": [
    "[17 1]",
    "0 1.5625 3.125 4.6875 6.25 7.8125 9.375 10.9375 12.5 14.0625 15.625 17.1875 18.75 20.3125 21.875 23.4375 25"
  ],
  "pwtwo": [
    "[16 1]",
    "0.15729053483194463 1.6403949158001192 2.0854004249211724 0.26387930574812324 0.55623393215198724 0.36523942986814006 0.010976654358017455 0.00035310618230734132 7.8588606826686665e-05 0.00035310618230734132 0.010976654358017455 0.36523942986814006 0.55623393215198724 0.26387930574812324 2.0854004249211724 1.6403949158001192"
  ],
  "pwtwo_f": [
    "[16 1]",
    "0 0.0625 0.125 0.1875 0.25 0.3125 0.375 0.4375 0.5 0.5625 0.625 0.6875 0.75 0.8125 0.875 0.9375"
  ],
  "pwcen": [
    "[16 1]",
    "9.324694061955594e-05 0.0007985396995841144 0.056754403792623323 0.096449331094868779 0.01544057999420541 0.35106201893317712 0.26220083742127154 0.011570241799054736 0.26220083742127154 0.35106201893317712 0.01544057999420541 0.096449331094868779 0.056754403792623323 0.0007985396995841144 9.324694061955594e-05 0.0001020840594102737"
  ],
  "pwcen_f": [
    "[16 1]",
    "-2.748893571891069 -2.3561944901923448 -1.9634954084936207 -1.5707963267948966 -1.1780972450961724 -0.78539816339744828 -0.39269908169872414 0 0.39269908169872414 0.78539816339744828 1.1780972450961724 1.5707963267948966 1.9634954084936207 2.3561944901923448 2.748893571891069 3.1415926535897931"
  ],
  "pwodd": [
    "[11 1]",
    "7.1370907471449523e-05 0.16998912497790972 1.1666841786457769 0.33304958509482502 0.0032028075364691887 0.1477812969085317 0.25235023508446625 0.015345281991261657 2.2740629759632381e-05 5.6198085532369381e-05 6.3218543357915848e-05"
  ],
  "pwodd_w": [
    "[11 1]",
    "0 0.29919930034188508 0.59839860068377015 0.89759790102565518 1.1967972013675403 1.4959965017094254 1.7951958020513104 2.0943951023931957 2.3935944027350806 2.6927937030769655 2.9919930034188504"
  ],
  "pwmat_size": [
    "[1 2]",
    "17 2"
  ],
  "pwmat_ratio": [
    "[17 1]",
    "4 4 4 4 4 4 4 4 4 4 4 3.9999999999999987 4.0000000000000151 4.0000000000000018 3.9999999999999822 4 4"
  ],
  "sg_size": [
    "[1 2]",
    "129 8"
  ],
  "sg_t": [
    "[1 8]",
    "1.7507043740108488 3.5014087480216975 5.2521131220325463 7.0028174960433951 8.753521870054243 10.504226244065093 12.254930618075941 14.00563499208679"
  ],
  "sg_w3": [
    "[3 1]",
    "0 0.024543692606170259 0.049087385212340517"
  ],
  "sg_s11": [
    "[1 2]",
    "0.0046061602617526454 0"
  ],
  "sg_s52": [
    "[1 2]",
    "0.002719546057537936 -0.17225023757875646"
  ],
  "sg20_size": [
    "[1 2]",
    "17 9"
  ],
  "sg20_t": [
    "[1 9]",
    "1.5915494309189535 3.183098861837907 4.7746482927568605 6.366197723675814 7.9577471545947667 9.5492965855137211 11.140846016432674 12.732395447351628 14.323944878270581"
  ],
  "sg20_col1_re": [
    "[17 1]",
    "-0.010739342767234816 -0.8860165675442262 2.6732254207053132 1.8895279886366563 -4.2216299412962659 0.41130343121803825 0.3510662070832769 -1.1012695919355449 0.87214884936667736 1.9428946001616558 -1.2156134914483447 -0.11011168321983222 -0.00026356488433920688 0.019943302278339958 0.0087239682355231274 0.0010702885032377041 0.020740911046902177"
  ],
  "sg20_col1_im": [
    "[17 1]",
    "0 0.62327683363383102 2.1002461194184487 -4.7369751139173086 -0.31895442182759143 1.8487561224969913 -0.36316825326885599 0.12975479417878411 2.1119859482146972 -1.526015869252098 -0.85922829858039451 0.40424573456345736 -0.00089464183080562032 0.0051554684095922454 0.010378484010105771 -0.0079988367864789467 0"
  ],
  "sgfs_f": [
    "[17 1]",
    "0 1.5625 3.125 4.6875 6.25 7.8125 9.375 10.9375 12.5 14.0625 15.625 17.1875 18.75 20.3125 21.875 23.4375 25"
  ],
  "sgfs_t": [
    "[1 9]",
    "0.20000000000000001 0.40000000000000002 0.59999999999999998 0.80000000000000004 1 1.2 1.3999999999999999 1.6000000000000001 1.8"
  ],
  "sgps_col1": [
    "[17 1]",
    "3.0523616004276504e-07 0.0062114562355827284 0.061173311695314835 0.13766970623111388 0.0948730516578139 0.018986739251035292 0.0013504759133952111 0.0065085670013722927 0.027635983913764477 0.032306808842379554 0.011729466347347334 0.00092914752782455442 4.6042104204524115e-09 2.2459397130477353e-06 9.7298161769187616e-07 3.4472360681165364e-07 1.1385083791332772e-06"
  ],
  "sgps_size": [
    "[1 2]",
    "17 9"
  ],
  "sgtwo_size": [
    "[1 2]",
    "16 11"
  ],
  "sgtwo_t": [
    "[1 11]",
    "8 16 24 32 40 48 56 64 72 80 88"
  ],
  "sgodd_size": [
    "[1 2]",
    "11 5"
  ],
  "sgodd_t": [
    "[1 5]",
    "1.6711269024649011 4.2176059919352262 6.7640850814055522 9.3105641708758782 11.857043260346202"
  ],
  "sgodd_f": [
    "[11 1]",
    "0 0.29919930034188508 0.59839860068377015 0.89759790102565518 1.1967972013675403 1.4959965017094254 1.7951958020513104 2.0943951023931957 2.3935944027350806 2.6927937030769655 2.9919930034188504"
  ],
  "sgvecf_size": [
    "[1 2]",
    "3 11"
  ],
  "sgvecf_re": [
    "[3 1]",
    "-0.79909341075064677 -0.11898091046544869 1.5259546038154024"
  ],
  "hamming5": [
    "[5 1]",
    "0.080000000000000016 0.54000000000000004 1 0.54000000000000004 0.080000000000000016"
  ],
  "hann5": [
    "[5 1]",
    "0 0.5 1 0.5 0"
  ]
};

const EXACT = new Set(["hamming5", "hann5", "fz8_w", "fz5w_w", "fzdef_size", "fzdef_w_last", "fz_isrow", "pw_size", "pw_w2", "pw20_size", "pw20_10_32_w", "pwfs_f", "pwtwo_f", "pwcen_f", "pwmat_size", "sg_size", "sg_t", "sg_w3", "sg20_size", "sg20_t", "sgfs_f", "sgfs_t", "sgps_size", "sgtwo_size", "sgtwo_t", "sgodd_size", "sgodd_t", "sgvecf_size"]);

test("hamming, hann, freqz, pwelch and spectrogram: the rows of an observed MATLAB run", () => {
  const r = run(SCRIPT);
  assert.equal(r.status, 0, r.err);
  const got = new Map<string, [string, string]>();
  for (const line of r.out.trim().split("\n")) {
    const [name, size, values] = line.split("|");
    got.set(name, [size, (values ?? "").trim()]);
  }
  for (const [name, [size, values]] of Object.entries(MATLAB)) {
    const g = got.get(name);
    assert.ok(g, `${name}: not printed`);
    assert.equal(g[0], size, `${name}: size`);
    const want = values.split(" ").map(Number), have = g[1].split(" ").map(Number);
    assert.equal(have.length, want.length, `${name}: count`);
    if (EXACT.has(name)) {
      assert.deepEqual(have, want, `${name}: MATLAB's values exactly`);
    } else {
      const scale = Math.max(...want.map(Math.abs), 1e-300);
      const err = Math.max(...want.map((w, k) => Math.abs(w - have[k])));
      assert.ok(err <= 1e-13 * scale, `${name}: ${err / scale} of the row's largest element`);
    }
  }
  assert.match(r.out, /^line25\|ERR\|signal:welchparse:NotEnoughSamplesForDefaultSettings The input record needs more than eight samples in order to use the default window and overlap\.$/m);
});

test("the windows' options and edges, freqz's plot and refusals", () => {
  const r = run([
    "disp(size(hamming(0))), disp(hamming(1)), disp(hann(1))",
    "w = hann(4, 'periodic'); fprintf('%.17g ', w); fprintf('\\n')",
    "try, hamming(5, 'flat'), catch e, disp(e.message), end",
    "try, freqz([1 1], 1, 8, 'half'), catch e, disp(e.message), end",
    "try, pwelch(randn(64, 1), 16, 8, [0.1 0.2]), catch e, disp(e.message), end",
    "try, pwelch(randn(64, 1), 16, 16), catch e, disp(e.message), end",
    "try, spectrogram(randn(8, 2)), catch e, disp(e.message), end",
    "freqz([1 1], 1, 16)",
    "figure; pwelch(cos(pi/4 * (0:63)'), 16, 8, 16)",
    "figure; spectrogram(cos(pi/2 * (0:99)'), 20, 10, 32)",
  ].join("\n"));
  assert.equal(r.status, 0, r.err);
  const lines = r.out.split("\n");
  assert.deepEqual(lines.slice(0, 9), ["     0     1", "     1", "     1", "0 0.5 1 0.5 ",
    "hamming: the sampling flag must be 'symmetric' or 'periodic'.",
    "freqz: 'half' is not supported in Sagebrush: the options are 'whole' and fs.",
    "pwelch: a vector of frequencies is not supported in Sagebrush: give nfft.",
    "pwelch: noverlap must be smaller than the window length.",
    "spectrogram: the input must be a vector."]);
  // (with no output, each plots: freqz the magnitude and phase in two subplots, pwelch the estimate in dB,
  // spectrogram an image)
  assert.match(r.out, /Figure with 2 plots: line through 16 points; x \(Normalized Frequency \(×π rad\/sample\)\) from 0 to 1, y \(Magnitude \(dB\)\)[^|]*\| line through 16 points;[^\n]*y \(Phase \(degrees\)\)/);
  assert.match(r.out, /line through 9 points; x \(Normalized Frequency \(×π rad\/sample\)\) from 0 to 1, y \(Power\/frequency \(dB\/\(rad\/sample\)\)\)/);
  assert.match(r.out, /image 9 by 17; x \(Normalized Frequency \(×π rad\/sample\)\) from -0\.03125 to 1\.031, y \(Samples\) from 5 to 95/);
});

// (argument checks and complex windows, as an observed MATLAB R2026b run gives them (values and identifiers only,
// 2026-11-22): a complex length or size is an error, never its real part; only the window length rounds, half away
// from zero, with MATLAB's warning; a noninteger noverlap or nfft is an error; a complex window vector is used as it
// is, normalized by sum(abs(w).^2))
const CX2 = [
  "x = sin(2*pi*0.1*(0:99)') + 0.5*cos(2*pi*0.27*(0:99)');",
  "b = [1 2 1]/4; a = [1 -0.5 0.25];",
  "try, v = hamming(4+1i); fprintf('c1|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c1|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = hann(4+1i); fprintf('c2|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c2|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = hamming(4.5); fprintf('c3|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c3|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = hamming(0); fprintf('c4|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c4|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = hamming(-1); fprintf('c5|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c5|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, [v,w] = freqz(b, a, 4+1i); fprintf('c6|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c6|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, [v,w] = freqz(b, a, 4.5); fprintf('c7|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c7|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = pwelch(x, 20, 10, 32+1i); fprintf('c8|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c8|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = pwelch(x, 20+1i, 10, 32); fprintf('c9|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c9|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = pwelch(x, 20, 10+1i, 32); fprintf('c10|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c10|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = pwelch(x, hamming(20)+1i, 10, 32); fprintf('c11|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c11|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = pwelch(x, 20.5, 10, 32); fprintf('c12|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c12|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = spectrogram(x, hamming(16)*(1+1i), 8, 16); fprintf('c13|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c13|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = spectrogram(x, 16, 8, 16+1i); fprintf('c14|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c14|ERR|%s|%s\\n', err.identifier, err.message); end",
  "try, v = spectrogram(x, 16+1i, 8, 16); fprintf('c15|OK|%s %d\\n', mat2str(size(v)), isreal(v)); catch err, fprintf('c15|ERR|%s|%s\\n', err.identifier, err.message); end"
].join("\n");
const CX2_MATLAB = [
  "c1|ERR|MATLAB:hamming:expectedReal|Expected L to be real.",
  "c2|ERR|MATLAB:hann:expectedReal|Expected L to be real.",
  "c3|OK|[5 1] 1",
  "c4|OK|[0 1] 1",
  "c5|ERR|MATLAB:hamming:expectedNonnegative|Expected L to be nonnegative.",
  "c6|ERR|MATLAB:expectedReal|Expected n to be real.",
  "c7|ERR|MATLAB:badsubscript|Array indices must be positive integers or logical values.",
  "c8|ERR|MATLAB:pwelch:expectedInteger|Expected NFFT to be integer-valued.",
  "c9|ERR|MATLAB:pwelch:expectedPositive|Expected WINDOW to be positive.",
  "c10|ERR|MATLAB:colon:operandsNotRealScalar|Colon operands must be real scalars.",
  "c11|OK|[17 1] 1",
  "c12|OK|[17 1] 1",
  "c13|OK|[9 11] 0",
  "c14|ERR|MATLAB:spectrogram:expectedInteger|Expected NFFT to be integer-valued.",
  "c15|ERR|MATLAB:spectrogram:expectedPositive|Expected WINDOW to be positive."
];
const ROUND = [
  "x = sin(2*pi*0.1*(0:99)') + 0.5*cos(2*pi*0.27*(0:99)');",
  "lastwarn(''); v = hamming(4.5); [m, id] = lastwarn; fprintf('w1|hamming(4.5)|%s|%s|%s\\n', id, m, mat2str(size(v)));",
  "lastwarn(''); v = hann(4.4); [m, id] = lastwarn; fprintf('w2|hann(4.4)|%s|%s|%s\\n', id, m, mat2str(size(v)));",
  "lastwarn(''); v = hamming(2.5); [m, id] = lastwarn; fprintf('w3|hamming(2.5)|%s|%s|%s\\n', id, m, mat2str(size(v)));",
  "lastwarn(''); v = pwelch(x, 20.5, 10, 32); [m, id] = lastwarn; fprintf('w4|pwelch(x,20.5,10,32)|%s|%s|%s\\n', id, m, mat2str(size(v)));",
  "lastwarn(''); v = spectrogram(x, 16.4, 8, 16); [m, id] = lastwarn; fprintf('w5|spectrogram(x,16.4,8,16)|%s|%s|%s\\n', id, m, mat2str(size(v)));",
  "lastwarn(''); try, v = pwelch(x, 20, 10.5, 32); [m, id] = lastwarn; fprintf('w6|pwelch(x,20,10.5,32)|%s|%s|%s\\n', id, m, mat2str(size(v))); catch e, fprintf('w6|pwelch(x,20,10.5,32)|ERR %s|%s\\n', e.identifier, e.message); end",
  "lastwarn(''); try, v = pwelch(x, 20, 10, 32.5); fprintf('w7|pwelch(x,20,10,32.5)|OK|%s\\n', mat2str(size(v))); catch e, fprintf('w7|pwelch(x,20,10,32.5)|ERR %s|%s\\n', e.identifier, e.message); end",
  "lastwarn(''); try, v = spectrogram(x, 16, 8.5, 16); [m, id] = lastwarn; fprintf('w8|spectrogram(x,16,8.5,16)|%s|%s|%s\\n', id, m, mat2str(size(v))); catch e, fprintf('w8|spectrogram(x,16,8.5,16)|ERR %s|%s\\n', e.identifier, e.message); end",
  "lastwarn(''); try, v = hamming(0.4); [m, id] = lastwarn; fprintf('w9|hamming(0.4)|%s|%s|%s\\n', id, m, mat2str(size(v))); catch e, fprintf('w9|hamming(0.4)|ERR %s|%s\\n', e.identifier, e.message); end"
].join("\n");
const ROUND_MATLAB = [
  "w1|hamming(4.5)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[5 1]",
  "w2|hann(4.4)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[4 1]",
  "w3|hamming(2.5)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[3 1]",
  "w4|pwelch(x,20.5,10,32)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[17 1]",
  "w5|spectrogram(x,16.4,8,16)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[9 11]",
  "w6|pwelch(x,20,10.5,32)|ERR MATLAB:badsubscript|Index in position 1 is invalid. Array indices must be positive integers or logical values.",
  "w7|pwelch(x,20,10,32.5)|ERR MATLAB:pwelch:expectedInteger|Expected NFFT to be integer-valued.",
  "w8|spectrogram(x,16,8.5,16)|ERR MATLAB:spectrogram:expectedInteger|Expected NOVERLAP to be integer-valued.",
  "w9|hamming(0.4)|signal:spectralwindows:InvalidOrderRounding|Rounding order to nearest integer.|[0 1]"
];
const CW = [
  "pc = @(t, v) fprintf('%s|%s|%s\\n', t, mat2str(size(v)), strtrim(sprintf('%.17g%+.17gi ', [real(v(:).'); imag(v(:).')])));",
  "x = ones(6, 1); win = [1; 1i; 1];",
  "try, s = spectrogram(x, win, 0, 3, 1, 'twosided'); pc('sg_s', s); catch e, fprintf('sg_s|ERR %s %s\\n', e.identifier, e.message); end",
  "try, [s, f, t, ps] = spectrogram(x, win, 0, 3, 1, 'twosided'); pc('sg_ps', ps); catch e, fprintf('sg_ps|ERR %s %s\\n', e.identifier, e.message); end",
  "try, p = pwelch(x, win, 0, 3, 1, 'twosided'); pc('pw', p); catch e, fprintf('pw|ERR %s %s\\n', e.identifier, e.message); end",
  "try, p = pwelch(x, win, 0, 3); pc('pw_one', p); catch e, fprintf('pw_one|ERR %s %s\\n', e.identifier, e.message); end",
  "x2 = sin(2*pi*0.1*(0:99)') + 0.5*cos(2*pi*0.27*(0:99)');",
  "try, p = pwelch(x2, hamming(20)+1i, 10, 32); pc('pw_big_first4', p(1:4)); catch e, fprintf('pw_big|ERR %s %s\\n', e.identifier, e.message); end",
  "try, s = spectrogram(x2, hamming(16)*(1+1i), 8, 16); pc('sg_big_col1_first4', s(1:4,1)); catch e, fprintf('sg_big|ERR %s %s\\n', e.identifier, e.message); end",
  "try, [s,f,t,ps] = spectrogram(x2, hamming(16)*(1+1i), 8, 16); pc('sg_big_ps_first4', ps(1:4,1)); catch e, fprintf('sg_big_ps|ERR %s %s\\n', e.identifier, e.message); end"
].join("\n");
const CW_MATLAB: Record<string, [string, string]> = {
  "sg_s": [
    "[3 2]",
    "2+1i 1.3660254037844386+0.3660254037844386i -0.3660254037844386-1.3660254037844386i 2+1i 1.3660254037844386+0.3660254037844386i -0.3660254037844386-1.3660254037844386i"
  ],
  "sg_ps": [
    "[3 2]",
    "1.6666666666666667+0i 0.66666666666666663+0i 0.66666666666666663+0i 1.6666666666666667+0i 0.66666666666666663+0i 0.66666666666666663+0i"
  ],
  "pw": [
    "[3 1]",
    "1.6666666666666667+0i 0.66666666666666663+0i 0.66666666666666663+0i"
  ],
  "pw_one": [
    "[2 1]",
    "0.26525823848649227+0i 0.21220659078919377+0i"
  ],
  "pw_big_first4": [
    "[4 1]",
    "0.0011975092828196746+0i 0.14756475787239753+0i 0.25718276574242854+0i 1.4368517809565651+0i"
  ],
  "sg_big_col1_first4": [
    "[4 1]",
    "-0.88286382474298508-0.88286382474298508i 2.4776141441577648+3.7084911951267951i -1.935374034741649-4.6811951383089134i 0.21780234489538119+0.50737465403060988i"
  ],
  "sg_big_ps_first4": [
    "[4 1]",
    "0.020788465147134873+0i 0.5305203564535409+0i 0.68435133508009871+0i 0.0081310242783120407+0i"
  ]
};

test("complex lengths and sizes, noninteger lengths, noverlap and nfft: MATLAB's errors, warnings and sizes", () => {
  const a = run(CX2), b = run(ROUND);
  assert.equal(a.status, 0, a.err);
  assert.equal(b.status, 0, b.err);
  assert.deepEqual(a.out.trim().split("\n"), CX2_MATLAB);
  assert.deepEqual(b.out.trim().split("\n"), ROUND_MATLAB);
  // (the rounding warning, as MATLAB prints it: once for each rounded window length)
  assert.equal((a.err + b.err).split("Warning: Rounding order to nearest integer.").length - 1, 8);
});

test("a complex window vector: its imaginary part kept, the PSD normalized by sum(abs(w).^2)", () => {
  // (x = ones(6, 1) and the window [1; 1i; 1] window each segment to [1, i, 1]: s is its DFT, the PSD |s|^2 / 3)
  const r = run(CW);
  assert.equal(r.status, 0, r.err);
  const parse = (v: string) => v.split(" ").map((t) => {
    const m = /^([-+]?[\d.e+-]+?)([-+][\d.e+-]+)i$/.exec(t);
    return m ? [Number(m[1]), Number(m[2])] : [Number(t), 0];
  });
  const got = new Map(r.out.trim().split("\n").map((l) => { const [n, sz, v] = l.split("|"); return [n, [sz, v.trim()]]; }));
  for (const [name, [size, values]] of Object.entries(CW_MATLAB)) {
    const g = got.get(name);
    assert.ok(g, `${name}: not printed`);
    assert.equal(g[0], size, `${name}: size`);
    const want = parse(values), have = parse(g[1]);
    const scale = Math.max(...want.map(([x, y]) => Math.hypot(x, y)));
    const err = Math.max(...want.map(([x, y], k) => Math.hypot(x - have[k][0], y - have[k][1])));
    assert.ok(err <= 1e-13 * scale, `${name}: ${err / scale} of the row's largest element`);
  }
});
