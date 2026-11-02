"""pylab: numpy and matplotlib.pyplot in one namespace, as matplotlib's
pylab module, for code written with `from pylab import *`.  (matplotlib
discourages pylab; `import numpy as np` and `import matplotlib.pyplot as plt`
are the usual imports.)
"""

from numpy import *  # noqa: F401,F403
from matplotlib.pyplot import *  # noqa: F401,F403
