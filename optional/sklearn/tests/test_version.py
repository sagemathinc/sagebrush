# The package's own version: sklearn.__version__ and the distribution's
# metadata both answer Sagebrush's, not scikit-learn's.
import importlib.metadata as md
import sklearn
from _cases import case

case("version", lambda: sklearn.__version__)
case("metadata", lambda: md.version("scikit-learn"))
case("metadata-normalized", lambda: md.version("scikit_learn"))
case("not-sklearn", lambda: md.version("sklearn"))
