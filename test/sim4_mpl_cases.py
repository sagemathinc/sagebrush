# matplotlib's semilogx, semilogy and loglog: the axis made a log one, then
# plot. test/sim4-gaps.test.ts checks what this prints against what matplotlib
# 3.11.1 prints (CI's python3 has no matplotlib).
import matplotlib.pyplot as plt

# semilogx, semilogy and loglog: the axis made log, then plot
fig, ax = plt.subplots()
r = ax.semilogy([1, 2, 3], [1, 10, 100], "r-")
print([type(l).__name__ for l in r], ax.get_xscale(), ax.get_yscale())
fig, ax = plt.subplots()
r = ax.semilogx([1, 10, 100], [1, 2, 3], label="x")
print([type(l).__name__ for l in r], ax.get_xscale(), ax.get_yscale())
fig, ax = plt.subplots()
r = ax.loglog([1, 10, 100], [1, 10, 100], [1, 10], [5, 50])
print([type(l).__name__ for l in r], ax.get_xscale(), ax.get_yscale())
plt.figure()
r = plt.semilogy([0, 1, 2], [1, 1e3, 1e6], base=10)
print([type(l).__name__ for l in r], plt.gca().get_xscale(), plt.gca().get_yscale())
r = plt.loglog([1, 2], [3, 4])
print(len(r), plt.gca().get_xscale(), plt.gca().get_yscale())
r = plt.semilogx([1, 2], [3, 4])
print(len(r), plt.gca().get_xscale(), plt.gca().get_yscale())
