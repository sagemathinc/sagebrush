"""importlib.metadata, for the distributions this runtime has: the curated
PyPI packages (packages/pypi-<name>/, pinned in its package registry).

CPython 3.14's Lib/importlib/metadata reads installed distributions'
*.dist-info directories; Sagebrush installs none, so this module is not a
copy (PSF License; see cdn/LICENSE-CPython.txt). Its parts:

- version(name): a curated package's pinned version, looked up by the
  project's normalized name, as CPython's Prepared.normalize does it;
- PackageNotFoundError, as CPython's (a ModuleNotFoundError), for any other
  name: Sagebrush's own modules (numpy, say) are not distributions here;
- the rest of CPython's API (distribution, metadata, entry_points, files,
  requires, ...) is refused with NotImplementedError naming it, never
  answered with something plausible.
"""
import re

__all__ = ["PackageNotFoundError", "version"]

# (CPython's names this module does not provide: refused when asked for)
_REFUSED = {
    "Distribution", "DistributionFinder", "PackageMetadata", "EntryPoint", "EntryPoints",
    "PackagePath", "FileHash", "MetadataPathFinder", "PathDistribution",
    "distribution", "distributions", "entry_points", "files", "metadata",
    "packages_distributions", "requires",
}


class PackageNotFoundError(ModuleNotFoundError):
    """The package was not found."""

    def __str__(self) -> str:
        return f"No package metadata was found for {self.name}"

    @property
    def name(self) -> str:  # type: ignore[override]
        (name,) = self.args
        return name


def _normalize(name):
    """PEP 503 normalization plus dashes as underscores (CPython's
    Prepared.normalize)."""
    return re.sub(r"[-_.]+", "-", name).lower().replace("-", "_")


def _curated():
    """{normalized project name: version} of the curated packages in the
    registry, empty if there is none."""
    import builtins
    import json

    # (the reader called once: it is a builtin anyone can replace)
    reader = getattr(builtins, "__pyjs_package_registry__", None)
    raw = reader() if reader is not None else None
    reg = json.loads(raw) if raw is not None else {}
    out = {}
    for pkg in (reg.get("packages") or {}).values():
        info = pkg.get("pypi")
        if info:
            out[_normalize(info["project"])] = info["version"]
    return out


def version(distribution_name):
    """Get the version string for the named package.

    :param distribution_name: The name of the distribution package to query.
    :return: The version string for the package as defined in the package's
        "Version" metadata key.
    """
    # (as CPython's Distribution.from_name: an empty name, then not found;
    # its normalization needs a str, as re.sub does)
    if not distribution_name:
        raise ValueError("A distribution name is required.")
    found = _curated().get(_normalize(distribution_name))
    if found is None:
        raise PackageNotFoundError(distribution_name)
    return found


def __getattr__(name):
    if name in _REFUSED:
        raise NotImplementedError(f"importlib.metadata.{name} is not supported here: only version() "
                                  "and PackageNotFoundError, for the curated PyPI packages")
    raise AttributeError(f"module 'importlib.metadata' has no attribute {name!r}")
