"""ORENEX simulation engine — a dependency-free Python port.

This package is the backend counterpart of the ORENEX frontend's ``src/core``
TypeScript engine. It is a *reference implementation*: the frontend keeps and
uses its own TypeScript engine, and the two are intentionally independent.

Design notes
------------
* **Standard library only.** No numpy, no FastAPI, no third-party wheels — so it
  runs on any CPython including 3.14 with no install step.
* **Deterministic parity.** The seeded generator (mulberry32) and the Perlin
  noise are ported bit-for-bit from ``rng.ts`` / ``noise.ts`` so the same seed
  yields the same district, orebody and shortfall as the frontend.
* Module layout mirrors the TypeScript one, one module per ``*.ts`` file, with
  exported names lower-cased to snake_case.
"""

__version__ = "1.0.0"
