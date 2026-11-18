"""Georeferencing for the prototype surface (port of ``geo.ts``).

Everything the map draws lives in EPSG:32644 (WGS 84 / UTM zone 44N) metres — the
storage CRS declared in the architecture. The district AOI is the
Balaghat–Nagpur manganese belt: ~79.9°E, ~22.1°N.
"""

from __future__ import annotations

import math

from .noise import clamp

AOI = {
    "crs": "EPSG:32644",
    "minE": 703000,
    "minN": 7732000,
    "maxE": 768000,
    "maxN": 7790000,
}

AOI_WIDTH_M = AOI["maxE"] - AOI["minE"]  # 65 km
AOI_HEIGHT_M = AOI["maxN"] - AOI["minN"]  # 58 km


def norm_x(x: float) -> float:
    return clamp((x - AOI["minE"]) / AOI_WIDTH_M, 0, 1)


def norm_y(y: float) -> float:
    return clamp((y - AOI["minN"]) / AOI_HEIGHT_M, 0, 1)


def denorm_x(u: float) -> float:
    return AOI["minE"] + u * AOI_WIDTH_M


def denorm_y(v: float) -> float:
    return AOI["minN"] + v * AOI_HEIGHT_M


def utm44_to_lonlat(easting: float, northing: float) -> tuple[float, float]:
    """UTM zone 44N -> WGS84 lon/lat (inverse transverse Mercator)."""
    a = 6378137.0
    f = 1 / 298.257223563
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    lon0 = 81 * (math.pi / 180)
    x = easting - 500000
    y = northing
    M = y / k0
    mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2**3) / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )
    C1 = ep2 * math.cos(phi1) ** 2
    T1 = math.tan(phi1) ** 2
    N1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    R1 = (a * (1 - e2)) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    D = x / (N1 * k0)
    lat = phi1 - (N1 * math.tan(phi1) / R1) * (
        D**2 / 2
        - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D**4 / 24
        + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D**6 / 720
    )
    lon = lon0 + (
        D
        - (1 + 2 * T1 + C1) * D**3 / 6
        + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D**5 / 120
    ) / math.cos(phi1)
    return ((lon * 180) / math.pi, (lat * 180) / math.pi)
