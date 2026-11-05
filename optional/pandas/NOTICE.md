# Third-party notices: @sagebrush/pandas

## pandas 3.1.0 (BSD 3-Clause)

Parts of this package are ported from pandas 3.1.0 (https://github.com/pandas-dev/pandas). Its license is shipped with the package as `py/pandas/_pd_license.py`, whose docstring is pandas' LICENSE verbatim. The ported parts are:

- **`py/pandas/_pd_repr.py`:** the text and HTML reprs, from:
  - `pandas/io/formats/format.py`: SeriesFormatter, DataFrameFormatter, format_array and its formatters, _make_fixed_width, the zero trimming, format_name;
  - `pandas/io/formats/string.py`: StringFormatter;
  - `pandas/io/formats/printing.py`: adjoin, pprint_thing, _pprint_seq, format_object_summary, _TextAdjustment;
  - `pandas/io/formats/html.py`: HTMLFormatter, NotebookFormatter;
  - `pandas/core/indexes/base.py` and `range.py`: Index's repr and formatting.
- **`py/pandas/_pd_options.py`:** the options machinery, from:
  - `pandas/_config/config.py`;
  - the validators of `pandas/core/config_init.py`.

**Reimplemented, not ported:** `py/pandas/_pd_csv.py`'s tokenizer follows the states of `pandas/_libs/src/parser/tokenizer.c`, and its type inference follows the behaviour of `pandas/_libs/parsers.pyx` as measured on the oracle. Neither file's code is copied.

**Names:** `py/pandas/_pd_names.py` lists pandas 3.1.0's public names, taken from `dir()` on the oracle, so that a name outside the subset raises NotImplementedError.
