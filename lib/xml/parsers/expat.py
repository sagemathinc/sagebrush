# Copied unchanged from CPython 3.14 Lib/xml/parsers/expat.py (PSF License; see cdn/LICENSE-CPython.txt).
"""Interface to the Expat non-validating XML parser."""
import sys

from pyexpat import *

# provide pyexpat submodules as xml.parsers.expat submodules
sys.modules['xml.parsers.expat.model'] = model
sys.modules['xml.parsers.expat.errors'] = errors
