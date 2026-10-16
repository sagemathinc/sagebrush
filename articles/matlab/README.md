<!-- description: How Sagebrush runs MATLAB programs in the browser: a translator to Python, MATLAB's display and graphics reproduced, and checked against GNU Octave and published examples. -->
# MATLAB

:::disclaimer
**Sagebrush is not MATLAB, and has nothing to do with MathWorks.**

On these pages, "MATLAB" means the programming language only. Sagebrush is an independent implementation of that language, written from public documentation and tested against GNU Octave. It contains no code from MathWorks' MATLAB product and is not connected with it.

Sagebrush is not a product of The MathWorks, Inc., and is not affiliated with, sponsored by or endorsed by MathWorks in any way.

MATLAB is a registered trademark of The MathWorks, Inc.
:::

Sagebrush runs MATLAB programs: in the notebook, on boards, in the Jupyter
kernel and from the command line. A program is translated to Python and
runs on Sagebrush's numpy. It prints what MATLAB prints and draws MATLAB's
figures. There is no MathWorks code in it; it was written from MATLAB's
public documentation, and checked against GNU Octave and published
examples.

1. [How the MATLAB implementation works](01-how-it-works.md): the
   translator, the values, the display, files, graphics and notebooks; how
   it was tested; how close it is to MATLAB, by the numbers; and what would
   have saved time.
