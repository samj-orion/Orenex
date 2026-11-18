"""Port of ``geology.ts``.

The prototype surface: a synthetic but geologically structured model of the
Balaghat–Nagpur manganese belt (Sausar Group metasediments).

Why synthetic: SIH provides no dataset. Public geology + satellite are used for
the real layers; ore geometry, drillholes, production and equipment are generated
so the whole loop runs end-to-end. Every table produced here is flagged
is_synthetic, exactly as the data plan requires.

Record shapes (dict keys keep the TypeScript camelCase spelling):

* ``LithCode``   — ``'GON' | 'QSP' | 'IMP' | 'BIF' | 'GRN' | 'ALL' | 'DOL'``.
* ``GeoUnit``    — ``{id, code, name, favourable, cover, densityOffset,
  susceptibility, ring, areaKm2, provenance}``. ``ring`` is ``[x0, y0, x1, y1,
  ...]`` closed, UTM 44N metres. ``provenance`` is ``'mapped'`` or
  ``'interpreted'``.
* ``Structure``  — ``{id, kind, name, path, lengthKm, throwM, mapped}``.
  ``kind`` is ``'fault' | 'lineament' | 'shear' | 'dyke'``. ``path`` is a
  polyline ``[x0, y0, ...]`` in UTM. ``throwM`` is ``float | None``.
* ``Occurrence`` — ``{id, x, y, mnPct, depthTopM, source, year}``. ``source`` is
  ``'MOIL drillhole' | 'GSI NGDR' | 'Field sampling'``.
* ``MineSite``   — ``{id, name, code, x, y, miningMethod, designTpd, feedGradeMn,
  benchHeightM, commissioned, plan}``. ``miningMethod`` is
  ``'opencast' | 'underground'``; ``plan`` is ``{radiusM, benches, label}``.
* ``Terrain``    — ``{nx, ny, dem, shade, minZ, maxZ, slope, tpi, flow,
  cellWidthM, cellHeightM}``. ``dem``/``shade``/``slope``/``tpi``/``flow`` are
  float32 fields (``array.array('f')``).
"""

from __future__ import annotations

import math
from array import array

from .geo import AOI_HEIGHT_M, AOI_WIDTH_M, denorm_x, denorm_y, norm_x, norm_y
from .noise import clamp, make_fbm, make_noise_2d, make_ridged, sample_field, smoothstep
from .rng import make_rng, range_

GRID_NX = 168  # ~390 m cells (rendered field)
GRID_NY = 150  # ~387 m cells


def build_terrain() -> dict:
    nx = GRID_NX
    ny = GRID_NY
    rng = make_rng(20241017)
    fbm = make_fbm(9110, 6, 2.05, 0.52)
    ridge = make_ridged(4471, 5)
    dem = array("f", [0.0]) * (nx * ny)

    # Two fold limbs with a shared hinge: a syncline axis running WNW–ESE,
    # which is what gives the belt its elongated Mn horizon traces.
    axis_tilt = 0.20

    for j in range(ny):
        v = j / (ny - 1)
        for i in range(nx):
            u = i / (nx - 1)
            # Fold coordinate: distance from hinge, in normalised units.
            fold_coord = v - (0.44 + axis_tilt * (u - 0.5))
            limb = abs(fold_coord)

            # Regional trend: rises from the plains (south) into the Satpura
            # foot hills (north-east).
            regional = 340 + 300 * (0.62 * v + 0.38 * u)

            # Fold relief: limbs low, hinge high — amplitude modulated by noise.
            fold_relief = 210 * math.cos(min(limb * 2.6, math.pi / 2)) ** 1.4

            ridged = 150 * ridge(u * 3.1 + 4.2, v * 3.1 - 1.7)
            rough = 96 * fbm(u * 7.4, v * 7.4)
            detail = 26 * fbm(u * 19, v * 19)

            z = regional + fold_relief + ridged + rough + detail
            dem[j * nx + i] = z

    min_z = float("inf")
    max_z = float("-inf")
    for k in range(len(dem)):
        if dem[k] < min_z:
            min_z = dem[k]
        if dem[k] > max_z:
            max_z = dem[k]

    cell_w = AOI_WIDTH_M / (nx - 1)
    cell_h = AOI_HEIGHT_M / (ny - 1)

    # Slope from central differences (degrees).
    slope = array("f", [0.0]) * (nx * ny)
    for j in range(ny):
        for i in range(nx):
            i0 = max(0, i - 1)
            i1 = min(nx - 1, i + 1)
            j0 = max(0, j - 1)
            j1 = min(ny - 1, j + 1)
            dzdx = (dem[j * nx + i1] - dem[j * nx + i0]) / ((i1 - i0) * cell_w)
            dzdy = (dem[j1 * nx + i] - dem[j0 * nx + i]) / ((j1 - j0) * cell_h)
            slope[j * nx + i] = (math.atan(math.hypot(dzdx, dzdy)) * 180) / math.pi

    # Topographic position index (3x3 mean neighbourhood).
    tpi = array("f", [0.0]) * (nx * ny)
    for j in range(1, ny - 1):
        for i in range(1, nx - 1):
            k = j * nx + i
            total = (
                dem[k - 1] + dem[k + 1] + dem[k - nx] + dem[k + nx]
                + dem[k - nx - 1] + dem[k - nx + 1] + dem[k + nx - 1] + dem[k + nx + 1]
            )
            tpi[k] = dem[k] - total / 8

    # D8 flow accumulation on a small epsilon gradient to avoid flats.
    noise_field = make_noise_2d(7723)
    order = array("i", range(nx * ny))
    jitter = array("f", [0.0]) * (nx * ny)
    for j in range(ny):
        for i in range(nx):
            jitter[j * nx + i] = noise_field(i * 0.31, j * 0.31) * 0.6
    desc = sorted(order, key=lambda k: dem[k] + jitter[k], reverse=True)
    flow = array("f", [1.0]) * (nx * ny)
    for k in desc:
        i = k % nx
        j = math.floor(k / nx)
        best = -1
        best_drop = 0
        for dj in range(-1, 2):
            for di in range(-1, 2):
                if di == 0 and dj == 0:
                    continue
                ni = i + di
                nj = j + dj
                if ni < 0 or nj < 0 or ni >= nx or nj >= ny:
                    continue
                nk = nj * nx + ni
                dist = math.hypot(di * cell_w, dj * cell_h)
                drop = (dem[k] - dem[nk]) / dist
                if drop > best_drop:
                    best_drop = drop
                    best = nk
        if best >= 0 and best_drop > 0:
            flow[best] = flow[best] + flow[k]
    for k in range(len(flow)):
        flow[k] = math.log1p(flow[k]) / 6

    # Hillshade, sun azimuth 315° (NW), altitude 45°.
    shade = array("f", [0.0]) * (nx * ny)
    az = (315 * math.pi) / 180
    alt = (45 * math.pi) / 180
    slope_z = math.cos(alt)
    slope_x = math.cos(az) * math.sin(alt)
    slope_y = math.sin(az) * math.sin(alt)
    for j in range(ny):
        for i in range(nx):
            i0 = max(0, i - 1)
            i1 = min(nx - 1, i + 1)
            j0 = max(0, j - 1)
            j1 = min(ny - 1, j + 1)
            dzdx = -(dem[j * nx + i1] - dem[j * nx + i0]) / (2 * cell_w)
            dzdy = -(dem[j1 * nx + i] - dem[j0 * nx + i]) / (2 * cell_h)
            nz = 1
            length = math.sqrt(dzdx * dzdx + dzdy * dzdy + nz * nz)
            dot = (dzdx * slope_x + dzdy * slope_y + nz * slope_z) / length
            shade[j * nx + i] = clamp(dot, 0, 1)

    _ = rng  # TS keeps ``rng`` for future use (``void rng;``)
    return {
        "nx": nx,
        "ny": ny,
        "dem": dem,
        "shade": shade,
        "minZ": min_z,
        "maxZ": max_z,
        "slope": slope,
        "tpi": tpi,
        "flow": flow,
        "cellWidthM": cell_w,
        "cellHeightM": cell_h,
    }


TERRAIN: dict = build_terrain()


def elevation_at(x: float, y: float) -> float:
    return sample_field(TERRAIN["dem"], TERRAIN["nx"], TERRAIN["ny"], norm_x(x), norm_y(y))


# ── Geological units ────────────────────────────────────────────────────

# Rock properties per mapped unit.
#
# ``densityOffset`` and ``susceptibility`` are what make the synthetic
# geophysics consistent with the mapped geology: BIF is both dense and magnetic,
# alluvium is neither and buries everything. They are representative values, and
# the model card labels them as such.
UNIT_META: dict = {
    "GON": {"name": "Gondite / Mn-silicate", "favourable": True, "colour": "#8C6E4A", "cover": False, "densityOffset": 0.22, "susceptibility": 0.018},
    "QSP": {"name": "Quartzite–pelite", "favourable": True, "colour": "#C4B49A", "cover": False, "densityOffset": 0.04, "susceptibility": 0.006},
    "IMP": {"name": "Impure phyllite", "favourable": False, "colour": "#A8A196", "cover": False, "densityOffset": -0.02, "susceptibility": 0.009},
    "BIF": {"name": "Banded iron formation", "favourable": False, "colour": "#8E6B6B", "cover": False, "densityOffset": 0.31, "susceptibility": 0.061},
    "GRN": {"name": "Granite gneiss", "favourable": False, "colour": "#B0A9A0", "cover": False, "densityOffset": 0.11, "susceptibility": 0.014},
    "ALL": {"name": "Alluvium / laterite", "favourable": False, "colour": "#DCD3C0", "cover": True, "densityOffset": -0.14, "susceptibility": 0.003},
    "DOL": {"name": "Dolomite marble", "favourable": False, "colour": "#C9C6BD", "cover": False, "densityOffset": 0.07, "susceptibility": 0.004},
}


def build_units() -> list:
    """Builds mapped-unit polygons as banded traces that follow the fold geometry,
    so the map shows real structure rather than random blobs."""
    rng = make_rng(31337)
    units = []
    codes = ["GON", "QSP", "IMP", "DOL", "BIF", "GRN", "ALL"]
    # Band offsets across the fold, in metres from the hinge.
    band_offsets = [-5200, -3400, -1800, -600, 700, 2400, 4300, 6400]

    counter = 0
    for b in range(len(band_offsets)):
        offset = band_offsets[b]
        code = codes[b % len(codes)]
        for seg in range(2):
            if seg == 0:
                seg_start = 0.02
                seg_end = 0.42 + rng() * 0.06
            else:
                seg_start = 0.46 + rng() * 0.08
                seg_end = 0.99
            width = range_(rng, 1500, 3100)
            ring = []
            steps = 34
            jitter_phase = rng() * 100
            for s in range(steps + 1):
                t = seg_start + ((seg_end - seg_start) * s) / steps
                wobble = 700 * math.sin(t * 7.5 + jitter_phase) + 420 * math.sin(t * 17 + jitter_phase * 2)
                u = t
                hinge = 0.44 + 0.2 * (u - 0.5)
                v = clamp(hinge + (offset + wobble) / AOI_HEIGHT_M, 0.015, 0.985)
                ring.append(denorm_x(u))
                ring.append(denorm_y(v))
            # return band with perpendicular offset for width
            for s in range(steps, -1, -1):
                t = seg_start + ((seg_end - seg_start) * s) / steps
                wobble = 700 * math.sin(t * 7.5 + jitter_phase) + 420 * math.sin(t * 17 + jitter_phase * 2)
                u = t
                hinge = 0.44 + 0.2 * (u - 0.5)
                v = clamp(hinge + (offset + wobble + width) / AOI_HEIGHT_M, 0.015, 0.985)
                ring.append(denorm_x(u))
                ring.append(denorm_y(v))
            area = 0
            for k in range(0, len(ring), 2):
                k2 = (k + 2) % len(ring)
                area += ring[k] * ring[k2 + 1] - ring[k2] * ring[k + 1]
            area = abs(area / 2) / 1e6
            units.append({
                "id": f"GU-{counter + 1:03d}",
                "code": code,
                "name": UNIT_META[code]["name"],
                "favourable": UNIT_META[code]["favourable"],
                "cover": UNIT_META[code]["cover"],
                "densityOffset": UNIT_META[code]["densityOffset"],
                "susceptibility": UNIT_META[code]["susceptibility"],
                "ring": ring,
                "areaKm2": area,
                "provenance": "interpreted" if counter % 3 == 2 else "mapped",
            })
            counter += 1
    return units


GEO_UNITS: list = build_units()


def build_structures() -> list:
    rng = make_rng(8675309)
    out = []
    kinds = ["fault", "fault", "shear", "lineament", "lineament", "dyke"]

    for s in range(26):
        kind = kinds[s % len(kinds)]
        path = []
        steps = 12
        across = rng()
        along0 = rng() * 0.16
        along1 = 0.84 + rng() * 0.16
        steep = rng() > 0.68
        phase = rng() * 10
        for i in range(steps + 1):
            t = along0 + ((along1 - along0) * i) / steps
            base = across + (0.11 * math.sin(t * 6.1 + phase) if steep else 0.028 * math.sin(t * 9.4 + phase * 1.7))
            u = t
            v = clamp(base, 0.01, 0.99)
            path.append(denorm_x(u))
            path.append(denorm_y(v))
        length = 0
        for k in range(2, len(path), 2):
            length += math.hypot(path[k] - path[k - 2], path[k + 1] - path[k - 1])
        out.append({
            "id": f"ST-{s + 1:03d}",
            "kind": kind,
            "name": (
                f"{'Dyke' if kind == 'dyke' else 'Lineament' if kind == 'lineament' else 'Shear zone' if kind == 'shear' else 'Fault'}"
                f" {chr(65 + (s % 6))}{1 + math.floor(s / 6)}"
            ),
            "path": path,
            "lengthKm": length / 1000,
            "throwM": range_(rng, 45, 210) if kind == "fault" else None,
            "mapped": kind != "lineament" and rng() > 0.3,
        })
    return out


STRUCTURES: list = build_structures()

# ── Mines and occurrences ───────────────────────────────────────────────

MINES: list = [
    {
        "id": "MNE-BAL",
        "name": "Balaghat Deep Cast",
        "code": "BDC",
        "x": denorm_x(0.235),
        "y": denorm_y(0.415),
        "miningMethod": "opencast",
        "designTpd": 1450,
        "feedGradeMn": 27.4,
        "benchHeightM": 5,
        "commissioned": 2009,
        # Phase 4 pit extension: 95 m working radius, one bench of ore released.
        "plan": {"radiusM": 95, "benches": 1, "label": "Phase 4 pit, active bench"},
    },
    {
        "id": "MNE-NAG",
        "name": "Nagpur Ridge UG",
        "code": "NRU",
        "x": denorm_x(0.565),
        "y": denorm_y(0.318),
        "miningMethod": "underground",
        "designTpd": 820,
        "feedGradeMn": 24.1,
        "benchHeightM": 4,
        "commissioned": 2014,
        # Panel C: 70 m panel radius, current stoping level.
        "plan": {"radiusM": 70, "benches": 1, "label": "Panel C, current stope level"},
    },
    {
        "id": "MNE-BHA",
        "name": "Bhandara East Pit",
        "code": "BEP",
        "x": denorm_x(0.775),
        "y": denorm_y(0.665),
        "miningMethod": "opencast",
        "designTpd": 1100,
        "feedGradeMn": 25.8,
        "benchHeightM": 5,
        "commissioned": 2017,
        # East wall cut-back: 90 m working radius, two benches released.
        "plan": {"radiusM": 90, "benches": 2, "label": "East wall cut-back, two released benches"},
    },
]


# ``distToPath``/``distToRing`` are declared at the bottom of the TS file but JS
# hoists function declarations; Python does not, and OCCURRENCES is built at
# import time, so they are defined here (ahead of their first use) instead.

def dist_to_path(x: float, y: float, path: list) -> float:
    """Distance from a point to a polyline, in metres."""
    best = float("inf")
    i = 0
    while i + 3 < len(path):
        ax = path[i]
        ay = path[i + 1]
        bx = path[i + 2]
        by = path[i + 3]
        dx = bx - ax
        dy = by - ay
        len_sq = dx * dx + dy * dy or 1
        t = ((x - ax) * dx + (y - ay) * dy) / len_sq
        t = clamp(t, 0, 1)
        px = ax + t * dx
        py = ay + t * dy
        d = math.hypot(x - px, y - py)
        if d < best:
            best = d
        i += 2
    return best


def dist_to_ring(x: float, y: float, ring: list) -> float:
    """Distance from a point to a polygon ring, in metres (0 inside)."""
    inside = False
    best = float("inf")
    j = len(ring) - 2
    i = 0
    while i < len(ring):
        xi = ring[i]
        yi = ring[i + 1]
        xj = ring[j]
        yj = ring[j + 1]
        if (yi > y) != (yj > y) and x < ((xj - xi) * (y - yi)) / (yj - yi) + xi:
            inside = not inside
        dx = xj - xi
        dy = yj - yi
        len_sq = dx * dx + dy * dy or 1
        t = ((x - xi) * dx + (y - yi) * dy) / len_sq
        t = clamp(t, 0, 1)
        px = xi + t * dx
        py = yi + t * dy
        d = math.hypot(x - px, y - py)
        if d < best:
            best = d
        j = i
        i += 2
    return 0 if inside else best


def occurrence_favourability(x: float, y: float) -> float:
    """Geological favourability for an undiscovered Mn occurrence, 0–1.

    Built from mapped geology and structure only — the same evidence a field
    geologist would weigh before recommending a traverse. Deliberately excludes
    the remote-sensing and geophysical layers, because those are what the M1
    prospectivity model is supposed to *discover* the value in. If the
    occurrences were not placed with respect to the host horizon and the
    structures, there would be nothing for the model to find and no validation
    could ever be meaningful.
    """
    d_host = float("inf")
    for u in GEO_UNITS:
        if not u["favourable"]:
            continue
        d = dist_to_ring(x, y, u["ring"])
        if d < d_host:
            d_host = d
    # On the mapped horizon, or within a couple of kilometres of it.
    host = 1 - smoothstep(0, 2600, d_host)

    d_structure = float("inf")
    for s in STRUCTURES:
        d = dist_to_path(x, y, s["path"])
        if d < d_structure:
            d_structure = d
    structure = 1 - smoothstep(0, 1800, d_structure)

    # Ridges erode and expose the horizon; alluvium buries it.
    relief = clamp((elevation_at(x, y) - 470) / 260, 0, 1)

    return clamp(0.52 * host + 0.33 * structure + 0.15 * relief, 0, 1)


def build_occurrences() -> list:
    rng = make_rng(6161)
    out = []
    # Deposits are distinct — keep them at least this far apart, metres.
    min_sep_m = 1400

    def too_close(x: float, y: float) -> bool:
        return any(math.hypot(o["x"] - x, o["y"] - y) < min_sep_m for o in out)

    def place(cx: float, cy: float, radius: float, tries: int = 60):
        """Rejection-sample one occurrence from a candidate position, accepting
        with probability proportional to the cubed favourability. Cubing sharpens
        the contrast so genuinely unfavourable ground stays genuinely empty, while
        still leaving a tail of occurrences in weak ground — which is what makes
        the model worth calibrating rather than trivial."""
        best = None
        for _t in range(tries):
            ang = rng() * math.pi * 2
            r = radius * math.sqrt(rng())
            x = cx + math.cos(ang) * r
            y = cy + math.sin(ang) * r
            if too_close(x, y):
                continue
            fav = occurrence_favourability(x, y)
            if best is None or fav > best["fav"]:
                best = {"x": x, "y": y, "fav": fav}
            if rng() < fav ** 3:
                return {"x": x, "y": y}
        return best

    # Brownfield occurrences around the three operating mines.
    for mine in MINES:
        n = 7 + math.floor(rng() * 3)
        for _i in range(n):
            p = place(mine["x"], mine["y"], 4200)
            if p is None:
                continue
            out.append({
                "id": f"OCC-{mine['code']}-{len(out) + 1:02d}",
                "x": p["x"],
                "y": p["y"],
                # Nearer the host horizon, the richer the intercept.
                "mnPct": clamp(9 + 32 * occurrence_favourability(p["x"], p["y"]) + (rng() - 0.5) * 7, 6, 44),
                "depthTopM": clamp(4 + 78 * (1 - occurrence_favourability(p["x"], p["y"])) + rng() * 22, 3, 104),
                "source": "MOIL drillhole" if rng() > 0.45 else "GSI NGDR" if rng() > 0.4 else "Field sampling",
                "year": 1998 + math.floor(rng() * 27),
            })

    # Regional occurrences: the label set the greenfield model is trained on.
    for i in range(46):
        p = place(denorm_x(0.5), denorm_y(0.5), 34000, 90)
        if p is None:
            continue
        fav = occurrence_favourability(p["x"], p["y"])
        out.append({
            "id": f"OCC-REG-{i + 1:03d}",
            "x": p["x"],
            "y": p["y"],
            "mnPct": clamp(8 + 28 * fav + (rng() - 0.5) * 6, 5, 40),
            "depthTopM": clamp(3 + 84 * (1 - fav) + rng() * 18, 3, 110),
            "source": "GSI NGDR" if rng() > 0.55 else "Field sampling",
            "year": 1978 + math.floor(rng() * 44),
        })
    return sorted(out, key=lambda o: o["id"])


OCCURRENCES: list = build_occurrences()
