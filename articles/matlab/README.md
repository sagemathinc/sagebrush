<!-- description: How Sagebrush runs MATLAB programs in the browser: a translator to Python, MATLAB's display and graphics reproduced, and checked against GNU Octave, MathWorks' documentation and MATLAB itself. -->
# MATLAB

Sagebrush runs MATLAB programs: in the notebook, on boards, in the Jupyter
kernel and from the command line. A program is translated to Python and
runs on Sagebrush's numpy. It prints what MATLAB prints and draws MATLAB's
figures. There is no MathWorks code in it; it was written from MATLAB's
documentation, and checked against GNU Octave and against MATLAB itself.

1. [How the MATLAB implementation works](01-how-it-works.md): the
   translator, the values, the display, files, graphics and notebooks; how
   it was tested; how close it is to MATLAB, by the numbers; and what would
   have saved time.
