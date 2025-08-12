"""Pytest configuration to make `src/` importable.

Adds the project root to `sys.path` so tests can `import src...` without
requiring installation as a package. Minimal and reversible.
"""
from __future__ import annotations
import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
