"""Write py/sklearn/datasets/_sk_data_<name>.py: scikit-learn 1.9.1's bundled data files and descriptions for wine,
iris, breast_cancer and digits, embedded as Python string literals (an optional package's Python modules are what
every host loads). CSV text as it is; digits' gzip bytes as base64. Run with the oracle's scikit-learn installed:

    $VENV/bin/python -I optional/sklearn/tests/gen-data.py optional/sklearn/py/sklearn/datasets
"""
import base64
import hashlib
import os
import sys

import sklearn
from sklearn.datasets import data as _data, descr as _descr

out = sys.argv[1]
DATA = os.path.dirname(_data.__file__)
DESCR = os.path.dirname(_descr.__file__)
SETS = {
    "wine": ("wine_data.csv", "wine_data.rst"),
    "iris": ("iris.csv", "iris.rst"),
    "breast_cancer": ("breast_cancer.csv", "breast_cancer.rst"),
    "digits": ("digits.csv.gz", "digits.rst"),
}
for name, (data_file, descr_file) in SETS.items():
    raw = open(os.path.join(DATA, data_file), "rb").read()
    descr = open(os.path.join(DESCR, descr_file), encoding="utf-8").read()
    with open(os.path.join(out, "_sk_data_%s.py" % name), "w", encoding="utf-8") as f:
        f.write('"""scikit-learn %s\'s %s and %s, embedded (tests/gen-data.py); sha256 of the data file %s.\n'
                'The data is the UCI Machine Learning Repository\'s, CC BY 4.0 (NOTICE.md)."""\n\n'
                % (sklearn.__version__, data_file, descr_file, hashlib.sha256(raw).hexdigest()))
        if data_file.endswith(".gz"):
            b64 = base64.b64encode(raw).decode("ascii")
            f.write("GZIP_BASE64 = (\n")
            for i in range(0, len(b64), 100):
                f.write("    %r\n" % b64[i:i + 100])
            f.write(")\n\n")
        else:
            f.write("CSV = (\n")
            for line in raw.decode("utf-8").splitlines(True):
                f.write("    %r\n" % line)
            f.write(")\n\n")
        f.write("DESCR = %r\n" % descr)
    print(name, len(raw), hashlib.sha256(raw).hexdigest()[:16])
