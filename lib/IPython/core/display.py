"""IPython.core.display: the display objects of IPython.display (HTML,
Markdown, Image, ...), where older notebooks import them from (from
IPython.core.display import HTML). As IPython 9's, it has no display()
itself: that is IPython.display's."""
from IPython.display import DisplayObject, HTML, Image, JSON, Latex, Markdown, Math, Pretty, SVG
