"""Alloy kernel-side module. Loaded in the IPython kernel to provide
SQL execution, cross-language data sharing, and chart generation."""

from .magic import load_ipython_extension, unload_ipython_extension

__all__ = ["load_ipython_extension", "unload_ipython_extension"]
