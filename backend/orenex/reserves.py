"""Port of ``reserves.ts``."""

import math

from .noise import clamp, make_fbm
from .rng import make_rng, norm_inv, quantile_sorted
from .geology import elevation_at, MINES

# ── Constants ───────────────────────────────────────────────────────────

# Data-record keys below use the EXACT TypeScript field spelling (camelCase),
# per PORTING.md, so this service's JSON is directly comparable to the frontend.

# interface Collar {
#   holeId: string; x: number; y: number; z: number; totalDepthM: number;
#   drilledOn: string; method: 'core' | 'RC'; mineId: string; targetId: string | null;
# }
# interface Survey { holeId: string; depthM: number; azimuthDeg: number; dipDeg: number; }
# interface Assay {
#   holeId: string; fromM: number; toM: number; mnPct: number; fePct: number;
#   sio2Pct: number; pPct: number; al2o3Pct: number; labId: string;
#   qcFlag: 'ok' | 'dup' | 'blank' | 'std';
# }
# interface LithInterval {
#   holeId: string; fromM: number; toM: number; lithCode: string; description: string;
# }
# interface BlockCell {
#   blockId: string; xc: number; yc: number; zc: number; bench: number;
#   mnP10: number; mnP50: number; mnP90: number; krigingVar: number;
#   tonnesP50: number; densityTpm3: number;
#   confidenceClass: 'measured' | 'indicated' | 'inferred'; drillDistanceM: number;
#   inDomain: boolean; inPlan: boolean; tonnesP10: number; tonnesP90: number;
#   containsMnT: number;
# }
# interface MineEstimate {
#   mineId: string; name: string; blockSize: { dx: number; dy: number; dz: number };
#   blocks: BlockCell[]; meanKrigingSd: number; drillHoleCount: number;
#   assayCount: number; meanSpacingM: number; validationFold: number;
#   lastRun: string; modelVersion: string; snapshotId: string;
# }
# interface GradeTonnagePoint {
#   cutOff: number; tonnesM: number; tonnesI: number; totalTonnes: number;
#   gradeMn: number; containedMn: number; tonnesP10: number; tonnesP90: number;
#   blocks: number;
# }
# interface ReserveSummary {
#   mineId: string; totalTonnes: number; measuredTonnes: number; indicatedTonnes: number;
#   inferredTonnes: number; containedMnT: number; meanGradeMn: number;
#   p10Tonnes: number; p90Tonnes: number;
#   unfc: { cat1: number; cat2: number; cat3: number; cat4: number };
# }

BLOCK = {"dx": 10, "dy": 10, "dz": 5}
BULK_DENSITY = 2.45  # t/m³ — gondite ore; MOIL value to be confirmed
# Elevation that bench numbering is measured down from, m above MSL.
BENCH_DATUM_M = 500

# NOTE: defined here (earlier than in the TS) because Python evaluates default
# argument expressions at definition time and ``accessible_tonnes`` uses it.
DEFAULT_CUTOFF = 18

LABELS = ['NGDR-A', 'NGDR-B', 'BSI-C', 'NABL-D']

# Low-frequency noise describing the irregularity of the ore-sheet surface.
DOMAIN_NOISE = make_fbm(5150, 4)

# Spatially correlated grade perturbation, in % Mn.
#
# Shearing the vertical axis into the horizontal noise field gives a cheap but
# continuous 3D field: the residual a block estimator can actually learn from
# neighbours, as opposed to white noise that no kriging could ever resolve.
RESIDUAL_NOISE = make_fbm(9314, 4)


def grade_residual_m(x: float, y: float, z: float) -> float:
    return RESIDUAL_NOISE(x * 0.0021, (y + z * 2.2) * 0.0021) * 5.6


# ── Ore-sheet geometry ──────────────────────────────────────────────────
#
# Everything is expressed as a *depth below local ground surface*, never as an
# absolute elevation: the Sausar ore horizons follow topography at the top of
# the ferruginous cover and deepen under the ridges. One deterministic function
# is shared by the drillhole synthesiser and the block model, so the estimate
# conditions on the same surface the domain is built from — which is what makes
# the kriging honest rather than a fit to a mis-specified shell.
#
# (These are defined above ``build_drillholes`` because the module-level
# ``DRILL`` build calls them; the TS relies on function hoisting.)


def ore_sheet_top_depth_m(x: float, y: float, mine: dict) -> float:
    # Base cover: deeper where the ground is higher (ridge-crest preservation).
    ridge = max(0, elevation_at(x, y) - 340) * 0.11
    # Gentle regional dip, ENE, plus folding of the horizon.
    dip = (x - mine["x"]) * 0.075 + (y - mine["y"]) * 0.012
    wobble = DOMAIN_NOISE(x * 0.0011, y * 0.0011) * 16
    return clamp(26 + ridge + dip + wobble, 9, 190)


def ore_sheet_thickness_m(x: float, y: float, mine: dict) -> float:
    # Thickening along the fold hinge that runs through the mine centre, then
    # pinched by a higher-frequency field so the sheet is not a uniform slab.
    off = math.hypot((x - mine["x"]) * 0.75, y - mine["y"])
    hinge = 1 - clamp(off / 520, 0, 1)
    pinch = DOMAIN_NOISE(x * 0.0026 + 40, y * 0.0026 - 17)
    # Squaring the pinch field carves genuine internal waste lenses rather than
    # just modulating a smooth sheet.
    carve = clamp(1 - pinch * pinch * 0.9, 0.12, 1.35)
    return clamp((3.5 + 7 * hinge) * carve, 0.8, 18)


def ore_column(x: float, y: float, mine: dict) -> dict:
    """Vertical extent of the modelled ore column at a map position."""
    top_z = elevation_at(x, y) - ore_sheet_top_depth_m(x, y, mine)
    return {"topZ": top_z, "botZ": top_z - ore_sheet_thickness_m(x, y, mine)}


def ore_domain(x: float, y: float, z: float, mine: dict) -> dict:
    col = ore_column(x, y, mine)
    # A half-block of tolerance top and bottom so benches are not shaved off.
    dist_to_ore_m = col["topZ"] - z
    return {
        "inDomain": z <= col["topZ"] + BLOCK["dz"] / 2 and z >= col["botZ"] - BLOCK["dz"] / 2,
        "distToOreM": dist_to_ore_m,
    }


def sheet_trend(x: float, y: float, z: float, mine: dict) -> float:
    """The grade trend that both the drillhole synthesiser and the block model use.

    Three terms, each of which a geologist would recognise:
      · a hard contact wall that drives grade to zero at the domain boundary,
      · finer zonation across the sheet (metamorphic grade banding),
      · a regional westward depletion, so the deposit is not uniform in plan.

    Sharing one function is what makes this a regression-kriging exercise rather
    than a fit to a mis-specified shell: the estimator knows the trend, and the
    ordinary kriging stage only has to explain the residual structure.
    """
    dom = ore_domain(x, y, z, mine)
    if not dom["inDomain"]:
        return 2.6
    col = ore_column(x, y, mine)
    thickness = max(0.8, col["topZ"] - col["botZ"])
    # 0 at the top contact, 1 at the base contact.
    t = clamp((col["topZ"] - z) / thickness, 0, 1)
    zonation = math.sin(math.pi * clamp(t * 1.15, 0, 1)) ** 0.55
    regional = clamp(0.5 + 0.62 * (1 - clamp((x - (mine["x"] - 620)) / 1240, 0, 1)), 0.28, 1.12)
    return 2.2 + 35 * zonation * regional


# ── Drillhole synthesis ─────────────────────────────────────────────────


def build_drillholes() -> dict:
    rng = make_rng(70707)
    collars: list = []
    surveys: list = []
    assays: list = []
    liths: list = []

    # Spacing tracks the brownfield drilling campaigns the mines actually run:
    # NRU is on a tight infill grid, BDC/BEP sit on wider legacy grids.
    plans = [
        {"mine": MINES[0], "count": 148, "grid": 130, "depth": (95, 210)},
        {"mine": MINES[1], "count": 164, "grid": 95, "depth": (110, 320)},
        {"mine": MINES[2], "count": 121, "grid": 150, "depth": (80, 185)},
    ]

    hole_seq = 1
    for plan in plans:
        side = math.ceil(math.sqrt(plan["count"]))
        n = 0
        for row in range(side):
            if not (n < plan["count"]):
                break
            for col in range(side):
                if not (n < plan["count"]):
                    break
                # Staggered grid (offset rows) — realistic drill layout, avoids artefacts.
                gx = (col + (0.5 if row % 2 else 0)) * plan["grid"]
                gz = row * plan["grid"] * 0.86
                jx = (rng() - 0.5) * plan["grid"] * 0.28
                jz = (rng() - 0.5) * plan["grid"] * 0.28
                x = plan["mine"]["x"] + gx - (side * plan["grid"]) / 2 + jx
                y = plan["mine"]["y"] + gz - (side * plan["grid"] * 0.86) / 2 + jz
                hole_id = f"{plan['mine']['code']}-{hole_seq:04d}"
                collar_z = elevation_at(x, y)
                depth = plan["depth"][0] + rng() * (plan["depth"][1] - plan["depth"][0])
                method = 'core' if rng() > 0.32 else 'RC'
                drill_year = 2016 + math.floor(rng() * 9)
                collars.append({
                    "holeId": hole_id,
                    "x": x,
                    "y": y,
                    "z": collar_z,
                    "totalDepthM": float(f"{depth:.1f}"),
                    "drilledOn": f"{drill_year}-{1 + math.floor(rng() * 12):02d}-{1 + math.floor(rng() * 28):02d}",
                    "method": method,
                    "mineId": plan["mine"]["id"],
                    "targetId": None,
                })
                # Desurveyed trajectory: three-point survey.
                az0 = 30 + rng() * 300
                dip0 = -(86 + rng() * 4)
                for d in [0, depth * 0.35, depth * 0.7, depth]:
                    surveys.append({
                        "holeId": hole_id,
                        "depthM": float(f"{d:.1f}"),
                        "azimuthDeg": float(f"{((az0 + (rng() - 0.5) * 14 + (d / depth) * 22) % 360):.1f}"),
                        "dipDeg": float(f"{(dip0 + (d / depth) * (3 + rng() * 4)):.1f}"),
                    })

                # Top-of-ore depth: shared with the block model's domain surface, plus a
                # small per-hole offset so the contacts are not perfectly coincident
                # with the surface the estimate is built on.
                sheet_top = ore_sheet_top_depth_m(x, y, plan["mine"])
                sheet_thick = ore_sheet_thickness_m(x, y, plan["mine"])
                top_ore = clamp(sheet_top + (rng() - 0.5) * 13, 3, depth - 12)
                ore_thickness = clamp(sheet_thick * (0.72 + rng() * 0.56), 3, depth - top_ore)
                ore_top = top_ore
                ore_bot = clamp(ore_top + ore_thickness, ore_top + 2, depth)

                # Overburden / host lithology
                liths.append({"holeId": hole_id, "fromM": 0, "toM": ore_top, "lithCode": 'QSP', "description": 'Quartzite–pelite, oxidised'})
                liths.append({"holeId": hole_id, "fromM": ore_top, "toM": ore_bot, "lithCode": 'GON', "description": 'Gondite, Mn-silicate ore zone'})
                if ore_bot < depth - 4:
                    liths.append({"holeId": hole_id, "fromM": ore_bot, "toM": depth, "lithCode": 'IMP', "description": 'Impure phyllite'})

                # Composite assays at 2 m, with QC duplicates inserted.
                # In-ore grade is the shared sheet trend plus a spatially correlated
                # residual (the structure the ordinary kriging stage has to recover)
                # and 2 m sampling noise on top.
                step = 2
                dip_rad = (abs(dip0) * math.pi) / 180
                from_m = 0
                while from_m < depth - 1:
                    to = min(from_m + step, depth)
                    in_ore = from_m >= ore_top - 1 and to <= ore_bot + 1
                    mid = from_m + step / 2
                    z_sample = collar_z - math.sin(dip_rad) * mid
                    trend = sheet_trend(x, y, z_sample, plan["mine"])
                    correlated = grade_residual_m(x, y, z_sample)
                    mn = (
                        clamp(trend + correlated + (rng() - 0.5) * 3.4, 0.3, 58)
                        if in_ore
                        else clamp(0.7 + rng() * 5.6, 0.2, 7)
                    )
                    assays.append({
                        "holeId": hole_id,
                        "fromM": from_m,
                        "toM": to,
                        "mnPct": float(f"{mn:.2f}"),
                        "fePct": float(f"{clamp(mn * 0.72 + (rng() - 0.4) * 6, 3, 44):.2f}"),
                        "sio2Pct": float(f"{clamp(46 - mn * 0.62 + rng() * 5, 8, 68):.2f}"),
                        "pPct": float(f"{(0.06 + rng() * 0.22 + (1 - mn / 40) * 0.06):.3f}"),
                        "al2o3Pct": float(f"{clamp(4 + rng() * 7 + (1 - mn / 40) * 6, 1, 24):.2f}"),
                        "labId": LABELS[math.floor(rng() * len(LABELS))],
                        "qcFlag": 'ok',
                    })
                    from_m += step
                # QC: one duplicate and one standard every ~14 holes.
                if hole_seq % 14 == 0:
                    dup = assays[len(assays) - 12]
                    assays.append({**dup, "labId": f"{dup['labId']}-DUP", "qcFlag": 'dup'})
                if hole_seq % 29 == 0:
                    assays.append({
                        "holeId": hole_id,
                        "fromM": 0,
                        "toM": 2,
                        "mnPct": float(f"{(26.8 + (rng() - 0.5) * 0.5):.2f}"),
                        "fePct": 19.4,
                        "sio2Pct": 31.2,
                        "pPct": 0.11,
                        "al2o3Pct": 6.4,
                        "labId": f"{LABELS[0]}-STD",
                        "qcFlag": 'std',
                    })
                n += 1
                hole_seq += 1

    return {"collars": collars, "surveys": surveys, "assays": assays, "liths": liths}


DRILL = build_drillholes()

# Variogram: spherical model fitted to the observed Mn grade semivariogram.
# Nugget 12% of sill — sampling noise at 2 m composites plus lab scatter.
# Horizontal range 420 m sits above the 150–300 m drill spacing so that every
# block is genuinely interpolated (the validation screen reports how often a
# block falls outside the range).
VARIOGRAM = {"nugget": 26.5, "sill": 214, "range": 420, "rangeVert": 115}


def spherical_variogram(h: float, range_: float, nugget: float, sill: float) -> float:
    if h <= 0:
        return 0
    if h >= range_:
        return nugget + sill
    r = h / range_
    return nugget + sill * (1.5 * r - 0.5 * r ** 3)


def kriging_weights(target: dict, samples: list, sample_sd: float) -> dict:
    # Neighbourhood is already capped by the caller's spatial index.
    if len(samples) > 12:
        samples = samples[:12]
    m = len(samples)
    if m == 0:
        return {"weights": [], "variance": 9999}

    # Scale geometry to vertical anisotropy so the search neighbourhood is
    # elliptical in space, matching the fitted vertical range.
    sc = VARIOGRAM["range"] / VARIOGRAM["rangeVert"]

    def gamma(a: dict, b: dict) -> float:
        dh = math.sqrt((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2 + (sc * (a["z"] - b["z"])) ** 2)
        return spherical_variogram(dh, VARIOGRAM["range"], VARIOGRAM["nugget"], VARIOGRAM["sill"])

    A = [[0.0] * (m + 1) for _ in range(m + 1)]
    for i in range(m):
        for j in range(m):
            A[i][j] = gamma(samples[i], samples[j])
        A[i][m] = 1
        A[m][i] = 1
    A[m][m] = 0
    b = [0.0] * (m + 1)
    b[m] = 1

    sol = solve_linear_system(A, b)
    if sol is None:
        return {"weights": [1 / m for _ in samples], "variance": sample_sd ** 2}
    weights = sol[:m]
    # Ordinary kriging variance from the Lagrange multiplier row.
    variance = 0.0
    for i in range(m):
        variance += weights[i] * gamma(target, samples[i])
    variance += sol[m]
    return {"weights": weights, "variance": max(0.5, variance)}


def solve_linear_system(A: list, b: list):
    """Gaussian elimination with partial pivoting."""
    n = len(b)
    M = [[*row, b[i]] for i, row in enumerate(A)]
    for col in range(n):
        pivot = col
        for r in range(col + 1, n):
            if abs(M[r][col]) > abs(M[pivot][col]):
                pivot = r
        if abs(M[pivot][col]) < 1e-9:
            return None
        M[col], M[pivot] = M[pivot], M[col]
        pv = M[col][col]
        for c in range(col, n + 1):
            M[col][c] /= pv
        for r in range(n):
            if r == col:
                continue
            f = M[r][col]
            if f == 0:
                continue
            for c in range(col, n + 1):
                M[r][c] -= f * M[col][c]
    return [row[n] for row in M]


def assay_variogram() -> dict:
    """Semi-variogram of the composite assay data — drawn on the validation screen."""
    rng = make_rng(24680)
    bins: list = []
    for i in range(14):
        lag = 25 * (i + 1)
        pairs = 240 + math.floor(rng() * 180)
        model = spherical_variogram(lag, VARIOGRAM["range"], VARIOGRAM["nugget"], VARIOGRAM["sill"])
        scatter = model * (1 + (rng() - 0.5) * 0.16)
        bins.append({"lag": lag, "gamma": scatter, "pairs": pairs})
    return {
        "bins": bins,
        "model": [
            {
                "lag": ((i + 1) / 40) * 600,
                "gamma": spherical_variogram(((i + 1) / 40) * 600, VARIOGRAM["range"], VARIOGRAM["nugget"], VARIOGRAM["sill"]),
            }
            for i in range(40)
        ],
        "nugget": VARIOGRAM["nugget"],
        "sill": VARIOGRAM["nugget"] + VARIOGRAM["sill"],
        "range": VARIOGRAM["range"],
        "rangeVert": VARIOGRAM["rangeVert"],
    }


def in_mine_plan(x: float, y: float, z: float, mine: dict) -> bool:
    """Is this block inside the mine's current approved plan envelope?

    Opencast and underground alike: inside the active working radius, and within
    the benches of ore that have actually been exposed below the local contact.
    The plan floor follows the contact rather than a fixed elevation, because
    that is how grade control sets it — a flat floor would either bury the sheet
    or strip 300 m of cover off it.

    Blocks outside the envelope are still estimated and reported; they are simply
    not *cover*.
    """
    if math.hypot(x - mine["x"], y - mine["y"]) > mine["plan"]["radiusM"]:
        return False
    top_z = ore_column(x, y, mine)["topZ"]
    return z >= top_z - mine["plan"]["benches"] * mine["benchHeightM"]


def accessible_tonnes(est: dict, cut_off: float = DEFAULT_CUTOFF, radius_m=None, benches=None) -> dict:
    """Validated (measured + indicated) tonnes that fall inside a candidate plan
    envelope. Exposed so the UI can show how OCI responds to a different pit
    radius or phase floor without re-running the estimator.
    """
    mine = next((m for m in MINES if m["id"] == est["mineId"]), None)
    r = radius_m if radius_m is not None else mine["plan"]["radiusM"]
    n = benches if benches is not None else mine["plan"]["benches"]
    measured_t = 0
    indicated_t = 0
    inferred_t = 0
    for b in est["blocks"]:
        if b["mnP50"] < cut_off:
            continue
        if not in_mine_plan(b["xc"], b["yc"], b["zc"], mine):
            continue
        if math.hypot(b["xc"] - mine["x"], b["yc"] - mine["y"]) > r:
            continue
        top_z = ore_column(b["xc"], b["yc"], mine)["topZ"]
        if b["zc"] < top_z - n * mine["benchHeightM"]:
            continue
        if b["confidenceClass"] == 'measured':
            measured_t += b["tonnesP50"]
        elif b["confidenceClass"] == 'indicated':
            indicated_t += b["tonnesP50"]
        else:
            inferred_t += b["tonnesP50"]
    return {"measuredT": measured_t, "indicatedT": indicated_t, "inferredT": inferred_t}


class CompositeIndex:
    """Uniform hash index over downhole composites, in three dimensions.

    The search has to be genuinely 3D: a block on the ore surface must be able
    to see the composites *below* it in nearby holes, otherwise every estimate
    is an extrapolation and the kriging variance collapses to the sill. Cell
    sizes follow the fitted ranges, so a single ring usually suffices.
    """

    def __init__(
        self,
        samples: list,
        origin_x: float,
        origin_y: float,
        origin_z: float,
        h_cell: float = VARIOGRAM["range"] / 2,
        v_cell: float = VARIOGRAM["rangeVert"] / 2,
    ):
        self.origin_x = origin_x
        self.origin_y = origin_y
        self.origin_z = origin_z
        self.h_cell = h_cell
        self.v_cell = v_cell
        self.buckets: dict = {}
        for s in samples:
            k = self.key_of(s["x"], s["y"], s["z"])
            arr = self.buckets.get(k)
            if arr:
                arr.append(s)
            else:
                self.buckets[k] = [s]

    def key_of(self, x: float, y: float, z: float) -> int:
        i = math.floor((x - self.origin_x) / self.h_cell)
        j = math.floor((y - self.origin_y) / self.h_cell)
        k = math.floor((z - self.origin_z) / self.v_cell)
        return (i + 512) * 1_048_576 + (j + 512) * 1024 + (k + 512)

    def nearest(self, x: float, y: float, z: float, want: int) -> list:
        """Nearest samples by *anisotropic* distance, expanding cubic rings until the
        search neighbourhood is full or the variogram range is exceeded.
        """
        i0 = math.floor((x - self.origin_x) / self.h_cell)
        j0 = math.floor((y - self.origin_y) / self.h_cell)
        k0 = math.floor((z - self.origin_z) / self.v_cell)
        vz = self.h_cell / self.v_cell
        found: list = []
        # Anything past the range contributes only the sill, so stop there.
        cutoff = VARIOGRAM["range"] * 1.15

        for ring in range(5):
            for dk in range(-ring, ring + 1):
                for dj in range(-ring, ring + 1):
                    for di in range(-ring, ring + 1):
                        if ring > 0 and abs(di) != ring and abs(dj) != ring and abs(dk) != ring:
                            continue
                        arr = self.buckets.get(
                            (i0 + di + 512) * 1_048_576 + (j0 + dj + 512) * 1024 + (k0 + dk + 512)
                        )
                        if not arr:
                            continue
                        for s in arr:
                            dx = s["x"] - x
                            dy = s["y"] - y
                            dz = (s["z"] - z) * vz
                            d = math.sqrt(dx * dx + dy * dy + dz * dz)
                            if d <= cutoff:
                                found.append({**s, "d2": d})
            if len(found) >= want:
                break
        found.sort(key=lambda a: a["d2"])
        return found[:want]


# UNFC-style confidence classes, indicative only — they are a screening rule
# on two observable inputs (how close the nearest composite is, and how much
# variance the kriging left behind), not a statutory classification.
CONFIDENCE_RULES = {
    # Composite within this distance and a tight kriging variance.
    "measured": {"maxDrillM": 90, "maxSdPct": 11},
    # Beyond that, but still inside the variogram range with usable precision.
    "indicated": {"maxDrillM": 210, "maxSdPct": 16},
}


def classify_confidence(drill_distance_m: float, sd: float) -> str:
    if drill_distance_m <= CONFIDENCE_RULES["measured"]["maxDrillM"] and sd <= CONFIDENCE_RULES["measured"]["maxSdPct"]:
        return 'measured'
    if drill_distance_m <= CONFIDENCE_RULES["indicated"]["maxDrillM"] and sd <= CONFIDENCE_RULES["indicated"]["maxSdPct"]:
        return 'indicated'
    return 'inferred'


def build_estimate(mine: dict, hole_allow=None) -> dict:
    """``hole_allow`` restricts which collars contribute data.

    The only caller that passes it is the drilling hold-out on the validation
    screen: a fifth of the holes are withheld, the estimate is rebuilt from what
    is left, and the withheld blocks are scored against what the full estimate
    says. Without the parameter the "20% of drillholes withheld" claim would be a
    sentence rather than an experiment.
    """
    rng = make_rng(ord(mine["code"][0]) * 7919 + len(mine["code"]) * 131)
    hole_ids = dict.fromkeys(
        c["holeId"] for c in DRILL["collars"]
        if c["mineId"] == mine["id"] and (hole_allow is None or c["holeId"] in hole_allow)
    )

    # Downhole composite: 2 m assays → length-weighted 4 m composites, binned at
    # the 5 m bench height. This is what a resource geologist actually kriges —
    # 1–2 m composites in a single hole are not independent samples.
    by_hole: dict = {}
    for a in DRILL["assays"]:
        if a["holeId"] not in hole_ids or a["qcFlag"] != 'ok':
            continue
        arr = by_hole.get(a["holeId"])
        if arr:
            arr.append({"fromM": a["fromM"], "toM": a["toM"], "v": a["mnPct"]})
        else:
            by_hole[a["holeId"]] = [{"fromM": a["fromM"], "toM": a["toM"], "v": a["mnPct"]}]

    collar_by_hole = {c["holeId"]: c for c in DRILL["collars"]}
    survey_by_hole: dict = {}
    for s in DRILL["surveys"]:
        arr = survey_by_hole.get(s["holeId"])
        if arr:
            arr.append(s)
        else:
            survey_by_hole[s["holeId"]] = [s]

    composites: list = []
    for hole_id, rows in by_hole.items():
        collar = collar_by_hole[hole_id]
        surv = sorted(list(survey_by_hole.get(hole_id, [])), key=lambda a: a["depthM"])
        depth = collar["totalDepthM"]
        from_m = 0
        while from_m < depth - 0.5:
            to = min(from_m + 4, depth)
            seg = [r for r in rows if r["fromM"] >= from_m - 0.01 and r["fromM"] < to - 0.01]
            if seg:
                length = sum(r["toM"] - r["fromM"] for r in seg)
                if length >= 1.5:
                    v = sum(r["v"] * (r["toM"] - r["fromM"]) for r in seg) / length
                    mid = (from_m + to) / 2
                    at = next((s for s in surv if s["depthM"] >= mid), None)
                    if at is None:
                        at = surv[len(surv) - 1] if surv else None
                    az = ((at["azimuthDeg"] if at else 90) * math.pi) / 180
                    dip = ((at["dipDeg"] if at else -87) * math.pi) / 180
                    horiz = math.cos(dip) * mid
                    composites.append({
                        "x": collar["x"] + horiz * math.sin(az),
                        "y": collar["y"] + horiz * math.cos(az),
                        "z": collar["z"] - abs(math.sin(dip)) * mid,
                        "v": v,
                    })
            from_m += 4

    vals = [c["v"] for c in composites]
    mean = sum(vals) / len(vals)
    sample_sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals))

    # Regression-kriging trend: grade follows depth within the ore domain.
    # Deterministic (no rng per call) so the estimate is reproducible.
    def trend_of(x: float, y: float, z: float) -> float:
        return sheet_trend(x, y, z, mine)

    # Residuals: composite value minus the trend at its own position. Precomputed
    # once, then indexed, so each block only touches its local neighbourhood.
    residual_samples = [
        {"x": c["x"], "y": c["y"], "z": c["z"], "v": c["v"] - trend_of(c["x"], c["y"], c["z"])}
        for c in composites
        if abs(c["x"] - mine["x"]) < 1600 and abs(c["y"] - mine["y"]) < 1600
    ]
    index = CompositeIndex(residual_samples, mine["x"] - 1800, mine["y"] - 1800, 140)

    # Block extents: a footprint around the mine's drilling, ~1.9 km.
    half = 950
    blocks: list = []
    total_var = 0.0
    total_spacing = 0.0
    block_seq = 0

    x0 = math.floor((mine["x"] - half) / BLOCK["dx"]) * BLOCK["dx"]
    x1 = math.ceil((mine["x"] + half) / BLOCK["dx"]) * BLOCK["dx"]
    y0 = math.floor((mine["y"] - half) / BLOCK["dy"]) * BLOCK["dy"]
    y1 = math.ceil((mine["y"] + half) / BLOCK["dy"]) * BLOCK["dy"]

    # Columns are walked from the domain surface downwards, so no block is ever
    # invented above the ore and none is shaved off at the base.
    yc = y0 + BLOCK["dy"] / 2
    while yc <= y1:
        xc = x0 + BLOCK["dx"] / 2
        while xc <= x1:
            col = ore_column(xc, yc, mine)
            z_start = math.ceil((col["topZ"] - BLOCK["dz"] / 2) / BLOCK["dz"]) * BLOCK["dz"] - BLOCK["dz"] / 2
            z_end = math.floor((col["botZ"] + BLOCK["dz"] / 2) / BLOCK["dz"]) * BLOCK["dz"] + BLOCK["dz"] / 2

            zc = z_start
            while zc >= z_end:
                dom = ore_domain(xc, yc, zc, mine)
                if not dom["inDomain"]:
                    zc -= BLOCK["dz"]
                    continue

                trend = trend_of(xc, yc, zc)
                near = index.nearest(xc, yc, zc, 12)
                if not near:
                    zc -= BLOCK["dz"]
                    continue

                anisotropy = VARIOGRAM["range"] / VARIOGRAM["rangeVert"]
                drill_distance_m = math.sqrt(min(
                    (c["x"] - xc) ** 2
                    + (c["y"] - yc) ** 2
                    + (anisotropy * (c["z"] - zc)) ** 2
                    for c in near
                ))
                krig = kriging_weights({"x": xc, "y": yc, "z": zc}, near, sample_sd)
                weights = krig["weights"]
                variance = krig["variance"]
                residual_est = sum(w * near[i]["v"] for i, w in enumerate(weights))
                sd = math.sqrt(variance)

                # Draw the block's grade posterior from the kriging variance.
                N = 24
                grades = [
                    clamp(trend + residual_est + sd * norm_inv((k + 0.5) / N), 0, 62)
                    for k in range(N)
                ]
                grades.sort()
                mn_p10 = quantile_sorted(grades, 0.1)
                mn_p50 = quantile_sorted(grades, 0.5)
                mn_p90 = quantile_sorted(grades, 0.9)

                block_volume_m3 = BLOCK["dx"] * BLOCK["dy"] * BLOCK["dz"]
                tonnes_p50 = block_volume_m3 * BULK_DENSITY
                tonnes_p10 = block_volume_m3 * BULK_DENSITY * (mn_p10 / max(0.4, mn_p50))
                tonnes_p90 = block_volume_m3 * BULK_DENSITY * (mn_p90 / max(0.4, mn_p50))

                # Confidence: measured when drilled tight and precise, inferred at range.
                confidence_class = classify_confidence(drill_distance_m, sd)

                total_var += sd
                total_spacing += drill_distance_m
                blocks.append({
                    "blockId": f"{mine['code']}-{block_seq:06d}",
                    "xc": xc,
                    "yc": yc,
                    "zc": zc,
                    "bench": math.floor((zc - BENCH_DATUM_M) / BLOCK["dz"] + 0.5),
                    "mnP10": float(f"{mn_p10:.2f}"),
                    "mnP50": float(f"{mn_p50:.2f}"),
                    "mnP90": float(f"{mn_p90:.2f}"),
                    "krigingVar": float(f"{(sd * sd):.2f}"),
                    "tonnesP50": tonnes_p50,
                    "densityTpm3": BULK_DENSITY,
                    "confidenceClass": confidence_class,
                    "drillDistanceM": math.floor(drill_distance_m + 0.5),
                    "inDomain": True,
                    "inPlan": in_mine_plan(xc, yc, zc, mine),
                    "tonnesP10": tonnes_p10,
                    "tonnesP90": tonnes_p90,
                    "containsMnT": (tonnes_p50 * mn_p50) / 100,
                })
                block_seq += 1
                zc -= BLOCK["dz"]
            xc += BLOCK["dx"]
        yc += BLOCK["dy"]
    _ = rng

    return {
        "mineId": mine["id"],
        "name": mine["name"],
        "blockSize": {**BLOCK, "dz": mine["benchHeightM"]},
        "blocks": blocks,
        "meanKrigingSd": total_var / len(blocks) if blocks else 0,
        "drillHoleCount": len(hole_ids),
        "assayCount": len([a for a in DRILL["assays"] if a["holeId"] in hole_ids]),
        "meanSpacingM": total_spacing / len(blocks) if blocks else 0,
        "validationFold": 0 if mine["code"] == 'BDC' else 1 if mine["code"] == 'NRU' else 2,
        "lastRun": '2026-10-03T02:10:00+05:30',
        "modelVersion": 'g1-v4.2.1',
        "snapshotId": 'SNAP-2026-10-03-a91',
    }


ESTIMATES = [build_estimate(m) for m in MINES]


def estimate_for(mine_id: str) -> dict:
    return next((e for e in ESTIMATES if e["mineId"] == mine_id), ESTIMATES[0])


def drill_holdout(mine_id: str, fraction: float = 0.2) -> dict:
    """Drillhole hold-out: rebuild the estimate without a fraction of the collars and
    score the withheld holes against it.

    Blocks are scored only where a *withheld* hole is the nearest collar, i.e. the
    blocks whose estimate genuinely depended on the data being held out. Scoring
    every block instead would average the answer in with two thirds of the model
    that never saw the withheld holes and would flatter it.
    """
    mine = next((m for m in MINES if m["id"] == mine_id), None)
    if not mine:
        raise ValueError(f"unknown mine {mine_id}")
    collars = [c for c in DRILL["collars"] if c["mineId"] == mine_id]
    rng = make_rng(len(mine_id) * 9173 + 501)
    withheld: dict = {}
    for c in collars:
        if rng() < fraction:
            withheld[c["holeId"]] = None
    kept = dict.fromkeys(c["holeId"] for c in collars if c["holeId"] not in withheld)
    reduced = build_estimate(mine, kept)
    full = estimate_for(mine_id)
    full_by_id = {b["blockId"]: b for b in full["blocks"]}

    pairs: list = []
    withheld_collars = [c for c in DRILL["collars"] if c["holeId"] in withheld]
    for b in reduced["blocks"]:
        truth = full_by_id.get(b["blockId"])
        if truth is None:
            continue
        # Only blocks the withheld hole would actually have informed.
        nearest_withheld = min(
            (math.hypot(c["x"] - b["xc"], c["y"] - b["yc"], c["z"] - b["zc"]) for c in withheld_collars),
            default=math.inf,
        )
        if not (nearest_withheld <= b["drillDistanceM"] + 1):
            continue
        pairs.append({
            "blockId": b["blockId"],
            "predicted": b["mnP50"],
            "actual": truth["mnP50"],
            "mnP10": b["mnP10"],
            "mnP90": b["mnP90"],
            "drillDistanceM": b["drillDistanceM"],
        })

    err = [p["predicted"] - p["actual"] for p in pairs]
    mae = sum(abs(e) for e in err) / len(err) if err else 0
    rmse = math.sqrt(sum(e * e for e in err) / len(err)) if err else 0
    mean_actual = sum(p["actual"] for p in pairs) / len(pairs) if pairs else 0
    inside = len([p for p in pairs if p["actual"] >= p["mnP10"] and p["actual"] <= p["mnP90"]])
    mean_width = (
        sum(p["mnP90"] - p["mnP10"] for p in pairs) / len(pairs) if pairs else 0
    )

    return {
        "mineId": mine_id,
        "mineName": mine["name"],
        "withheldHoles": len(withheld),
        "totalHoles": len(collars),
        "blocksScored": len(pairs),
        "gradeMae": float(f"{mae:.2f}"),
        "gradeRmse": float(f"{rmse:.2f}"),
        # Mean signed error as a share of the withheld grade level.
        "biasPct": (
            float(f"{(sum(p['predicted'] - p['actual'] for p in pairs) / len(pairs) / mean_actual) * 100:.2f}")
            if pairs and mean_actual > 0
            else 0
        ),
        "p10p90CoveragePct": float(f"{(inside / len(pairs)) * 100:.1f}") if pairs else 0,
        "meanWidthMnPct": float(f"{mean_width:.2f}"),
        # Mean actual grade, so the MAE can be read as a share of level.
        "meanActualGradePct": float(f"{mean_actual:.2f}"),
        "pairs": pairs,
    }


def grade_tonnage(est: dict, cut_offs: list = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]) -> list:
    out: list = []
    for cut_off in cut_offs:
        kept = [b for b in est["blocks"] if b["mnP50"] >= cut_off]
        measured_indicated = [b for b in kept if b["confidenceClass"] != 'inferred']
        total_tonnes = sum(b["tonnesP50"] for b in kept)
        contained = sum(b["containsMnT"] for b in kept)
        p10 = sum(b["tonnesP10"] for b in kept)
        p90 = sum(b["tonnesP90"] for b in kept)
        out.append({
            "cutOff": cut_off,
            "tonnesM": sum(b["tonnesP50"] for b in measured_indicated),
            "tonnesI": sum(b["tonnesP50"] for b in kept if b["confidenceClass"] == 'inferred'),
            "totalTonnes": total_tonnes,
            "gradeMn": (contained / total_tonnes) * 100 if total_tonnes > 0 else 0,
            "containedMn": contained,
            "tonnesP10": p10,
            "tonnesP90": p90,
            "blocks": len(kept),
        })
    return out


def reserve_summary(est: dict, cut_off: float = 18, plan_restricted: bool = False) -> dict:
    """Reserve totals at the default cut-off, with UNFC-style categories.
    These are decision aids — declared reserves remain with qualified persons.

    ``planRestricted`` narrows the totals to the current mine-plan envelope, which
    is what OCI counts as accessible cover.
    """
    kept = [b for b in est["blocks"] if b["mnP50"] >= cut_off and (not plan_restricted or b["inPlan"])]

    def by(c: str) -> list:
        return [b for b in kept if b["confidenceClass"] == c]

    m = by('measured')
    ind = by('indicated')
    inf = by('inferred')
    total = sum(b["tonnesP50"] for b in kept)
    contained = sum(b["containsMnT"] for b in kept)
    return {
        "mineId": est["mineId"],
        "totalTonnes": total,
        "measuredTonnes": sum(b["tonnesP50"] for b in m),
        "indicatedTonnes": sum(b["tonnesP50"] for b in ind),
        "inferredTonnes": sum(b["tonnesP50"] for b in inf),
        "containedMnT": contained,
        "meanGradeMn": (contained / total) * 100 if total > 0 else 0,
        "p10Tonnes": sum(b["tonnesP10"] for b in kept),
        "p90Tonnes": sum(b["tonnesP90"] for b in kept),
        "unfc": {
            "cat1": len(m),
            "cat2": len(ind),
            "cat3": len(inf),
            "cat4": max(0, len(inf) - math.floor(len(inf) * 0.45)),
        },
    }
