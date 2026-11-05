# The pandas oracle for @sagebrush-python's comparison tests

Only the comparison oracle uses this venv; Sagebrush itself never does.
- @sagebrush approved it on Nov 1, 2026.
- Rebuilt the same day on CI's exact interpreter, per @sagebrush's decision.

**Interpreter: CPython 3.14.9,** the build CI's setup-python installs.
- Archive: `py3149/python-3.14.9-linux-24.04-x64.tar.gz`, from actions/python-versions, sha256 `987af6a6858a59529d8f66a54d6484c7bc8127bafc19e651134ad3e01ea578d4`, unpacked to `py3149/root`.
- **Set `LD_LIBRARY_PATH=/scratch/sagebrush-python-pandas-oracle/py3149/root/lib`.** Without it the binary loads the system 3.14.4 libpython. `ldd venv/bin/python` must show `py3149/root/lib/libpython3.14.so.1.0`.

**venv:** `venv/`, with packages installed `--no-index` from `wheels/`:

| wheel | sha256 |
|---|---|
| `pandas-3.1.0-cp314-cp314-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl` | `e4455cdcc03e42c17233184e8e4ea65c3ed2925d8b1d9d7dd8e6fced3f6e43c1` |
| `numpy-2.5.1-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl` | `54ad769f17bc2d833b620851989f62054fb9ab93c969d9e1dc3c8e3d56beea21` |
| `python_dateutil-3.0.0-py2.py3-none-any.whl` | `3c79630202e4152c6add678446984236efe4f57e84d8e892aab0637bab82e9fd` |
| `six-1.17.0-py2.py3-none-any.whl` | `4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274` |
| `tzdata-2026.6-py2.py3-none-any.whl` | `0a10eec6e13ef16b627fabed9a5f2ba61a62b1c67f327305f4e7e412a70b4aec` |
| `openpyxl-3.1.5-py2.py3-none-any.whl` | `5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2` |
| `et_xmlfile-2.0.0-py3-none-any.whl` | `7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa` |

**pip freeze:** et_xmlfile==2.0.0, numpy==2.5.1, openpyxl==3.1.5, pandas==3.1.0, python-dateutil==3.0.0, six==1.17.0, tzdata==2026.6.

**openpyxl and et_xmlfile** (Nov 5, @sagebrush's approval for read_excel, PR B): installed `--no-index --no-deps` from the wheels above, so that pandas' read_excel has its engine in the oracle. Sagebrush never imports them. The tests' workbooks are written by the test programs themselves (generic data, no committed .xlsx).

**Checked:** pyarrow is absent, and `pd.Series(['a']).dtype` is `StringDtype(storage='python', na_value=nan)`.

**Not part of the oracle:** the earlier 3.14.4 venv was removed.
