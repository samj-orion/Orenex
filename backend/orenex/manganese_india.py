"""Port of ``manganeseIndia.ts``.

National manganese-mine inventory — India's 50 principal manganese mines and
ore blocks.

Provenance and accuracy
───────────────────────
Figures are compiled from public sources: the Indian Bureau of Mines (IBM)
*Indian Minerals Yearbook*, GSI mineral memoirs, MOIL and SANDUR (SMIORE)
statutory disclosures, and State DMG lease records. They are *indicative*
order-of-magnitude values, not audited mine-plan numbers:

  - ``confidence: 'high'``   — named operating mine, figures well documented.
  - ``confidence: 'medium'`` — named mine, capacity/grade in a known range.
  - ``confidence: 'low'``    — deposit or auction block; deposit-level estimate.

Coordinates are approximate centroids of the lease/block (WGS 84). Grade is
representative ROM/feed grade, not the saleable concentrate grade. For any
operative use these rows must be replaced with the latest IBM/State DMG
returns and the company's approved mining plan.

The tuple is deliberately shaped so it can be consumed directly as a training
set — see ``manganese_model.py``, which fits the grade regressor and the
premium-grade classifier on exactly this table.

Record shape (``ManganeseMine``)::

    {
        "id": str, "name": str, "operator": str, "state": str, "district": str,
        "belt": str, "oreType": OreType,
        "miningMethod": "opencast" | "underground",
        "lat": float, "lon": float,
        "capacityKt": float,  # annualised ROM ore capacity, thousand t/yr
        "gradeMn": float,     # representative ROM/feed grade, % Mn
        "reserveMt": float,   # remaining reserve + resource, million tonnes
        "commissioned": int,  # first year of recorded production
        "depthM": float,      # working / average depth below surface, m
        "phosphorusP": float, # phosphorus in ore, % P
        "confidence": "high" | "medium" | "low",
        "source": str,
    }
"""

from __future__ import annotations

from typing import Any, Dict, List

# ``type OreType = 'gondite' | 'kodurite' | 'lateritic' | 'sedimentary' | 'mixed'``
OreType = str

ManganeseMine = Dict[str, Any]

MANGANESE_MINES: List[ManganeseMine] = [
    # ── MOIL — Maharashtra (Nagpur & Bhandara) ────────────────────────────
    {
        "id": "IN-MH-01", "name": "Kandri Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Nagpur",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.372, "lon": 79.281,
        "capacityKt": 250, "gradeMn": 26.8, "reserveMt": 8.4, "commissioned": 1903, "depthM": 260, "phosphorusP": 0.09,
        "confidence": "high", "source": "MOIL AR 2023-24; IBM IMYB 2022",
    },
    {
        "id": "IN-MH-02", "name": "Munsar Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Nagpur",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.334, "lon": 79.352,
        "capacityKt": 200, "gradeMn": 25.6, "reserveMt": 6.1, "commissioned": 1905, "depthM": 205, "phosphorusP": 0.10,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MH-03", "name": "Beldongri Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Nagpur",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.401, "lon": 79.224,
        "capacityKt": 150, "gradeMn": 27.2, "reserveMt": 5.2, "commissioned": 1907, "depthM": 185, "phosphorusP": 0.08,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MH-04", "name": "Gumgaon Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Nagpur",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.418, "lon": 79.302,
        "capacityKt": 180, "gradeMn": 24.7, "reserveMt": 4.3, "commissioned": 1960, "depthM": 155, "phosphorusP": 0.11,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MH-05", "name": "Chikla Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Bhandara",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.351, "lon": 79.722,
        "capacityKt": 300, "gradeMn": 28.1, "reserveMt": 7.6, "commissioned": 1902, "depthM": 225, "phosphorusP": 0.07,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MH-06", "name": "Dongri Buzurg Mine", "operator": "MOIL Ltd", "state": "Maharashtra", "district": "Bhandara",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "opencast", "lat": 21.298, "lon": 79.664,
        "capacityKt": 450, "gradeMn": 30.2, "reserveMt": 12.3, "commissioned": 1903, "depthM": 65, "phosphorusP": 0.06,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },

    # ── MOIL — Madhya Pradesh (Balaghat) ──────────────────────────────────
    {
        "id": "IN-MP-01", "name": "Balaghat Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "underground", "lat": 21.812, "lon": 80.183,
        "capacityKt": 500, "gradeMn": 30.6, "reserveMt": 15.2, "commissioned": 1903, "depthM": 320, "phosphorusP": 0.05,
        "confidence": "high", "source": "MOIL AR 2023-24; IBM IMYB 2022",
    },
    {
        "id": "IN-MP-02", "name": "Tirodi Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "opencast", "lat": 21.683, "lon": 79.721,
        "capacityKt": 350, "gradeMn": 29.1, "reserveMt": 10.4, "commissioned": 1900, "depthM": 85, "phosphorusP": 0.06,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MP-03", "name": "Sitapatore Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "opencast", "lat": 21.752, "lon": 79.903,
        "capacityKt": 200, "gradeMn": 28.3, "reserveMt": 6.2, "commissioned": 1903, "depthM": 70, "phosphorusP": 0.07,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MP-04", "name": "Ukwa Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "underground", "lat": 21.968, "lon": 80.052,
        "capacityKt": 180, "gradeMn": 27.4, "reserveMt": 5.1, "commissioned": 1903, "depthM": 130, "phosphorusP": 0.08,
        "confidence": "high", "source": "MOIL AR 2023-24",
    },
    {
        "id": "IN-MP-05", "name": "Bharweli Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "underground", "lat": 21.901, "lon": 80.104,
        "capacityKt": 130, "gradeMn": 26.2, "reserveMt": 3.4, "commissioned": 1903, "depthM": 150, "phosphorusP": 0.09,
        "confidence": "medium", "source": "MOIL lease records",
    },
    {
        "id": "IN-MP-06", "name": "Ramrama Mine", "operator": "MOIL Ltd", "state": "Madhya Pradesh", "district": "Balaghat",
        "belt": "Balaghat", "oreType": "gondite", "miningMethod": "opencast", "lat": 21.852, "lon": 80.048,
        "capacityKt": 90, "gradeMn": 25.1, "reserveMt": 2.2, "commissioned": 2000, "depthM": 55, "phosphorusP": 0.10,
        "confidence": "low", "source": "State DMG lease record (indicative)",
    },

    # ── Karnataka (SANDUR / Ballari) ──────────────────────────────────────
    {
        "id": "IN-KA-01", "name": "Deogiri Mine", "operator": "Sandur Manganese & Iron Ores (SMIORE)", "state": "Karnataka", "district": "Ballari",
        "belt": "Sandur", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.101, "lon": 76.552,
        "capacityKt": 220, "gradeMn": 22.3, "reserveMt": 9.6, "commissioned": 1954, "depthM": 42, "phosphorusP": 0.04,
        "confidence": "high", "source": "SMIORE disclosure; IBM MCDR check report",
    },
    {
        "id": "IN-KA-02", "name": "Subbarayanahalli (SB Halli) Mine", "operator": "Sandur Manganese & Iron Ores (SMIORE)", "state": "Karnataka", "district": "Ballari",
        "belt": "Sandur", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.083, "lon": 76.531,
        "capacityKt": 150, "gradeMn": 21.2, "reserveMt": 6.3, "commissioned": 1960, "depthM": 38, "phosphorusP": 0.05,
        "confidence": "high", "source": "SMIORE disclosure",
    },
    {
        "id": "IN-KA-03", "name": "Yeshwanthnagar Mine", "operator": "Sandur Manganese & Iron Ores (SMIORE)", "state": "Karnataka", "district": "Ballari",
        "belt": "Sandur", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.122, "lon": 76.578,
        "capacityKt": 120, "gradeMn": 21.6, "reserveMt": 4.4, "commissioned": 1970, "depthM": 46, "phosphorusP": 0.05,
        "confidence": "medium", "source": "SMIORE operations",
    },
    {
        "id": "IN-KA-04", "name": "Sandur North Block", "operator": "Sandur Manganese & Iron Ores (SMIORE)", "state": "Karnataka", "district": "Ballari",
        "belt": "Sandur", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.148, "lon": 76.601,
        "capacityKt": 100, "gradeMn": 20.6, "reserveMt": 3.1, "commissioned": 1990, "depthM": 32, "phosphorusP": 0.06,
        "confidence": "low", "source": "Block-level estimate",
    },

    # ── Odisha (Keonjhar, Sundargarh, Koraput) ────────────────────────────
    {
        "id": "IN-OD-01", "name": "Bamebari Manganese Mine", "operator": "Tata Steel Ltd", "state": "Odisha", "district": "Keonjhar",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.051, "lon": 85.402,
        "capacityKt": 320, "gradeMn": 30.4, "reserveMt": 11.2, "commissioned": 1956, "depthM": 60, "phosphorusP": 0.06,
        "confidence": "high", "source": "IBM lease list; Odisha Steel & Mines",
    },
    {
        "id": "IN-OD-02", "name": "Guruda Manganese Mine", "operator": "Tata Steel Ltd", "state": "Odisha", "district": "Keonjhar",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.024, "lon": 85.381,
        "capacityKt": 210, "gradeMn": 29.3, "reserveMt": 7.4, "commissioned": 1962, "depthM": 55, "phosphorusP": 0.07,
        "confidence": "medium", "source": "IBM lease list",
    },
    {
        "id": "IN-OD-03", "name": "Bhanjapalli Manganese Mine", "operator": "Sri Rudrasen (private lessee)", "state": "Odisha", "district": "Keonjhar",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 21.948, "lon": 85.214,
        "capacityKt": 90, "gradeMn": 27.8, "reserveMt": 2.6, "commissioned": 2005, "depthM": 40, "phosphorusP": 0.08,
        "confidence": "low", "source": "Odisha Steel & Mines auction record",
    },
    {
        "id": "IN-OD-04", "name": "Kolra Manganese Mine", "operator": "Private lessee", "state": "Odisha", "district": "Sundargarh",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 21.962, "lon": 85.198,
        "capacityKt": 70, "gradeMn": 27.1, "reserveMt": 2.1, "commissioned": 2008, "depthM": 35, "phosphorusP": 0.09,
        "confidence": "low", "source": "Odisha Steel & Mines record",
    },
    {
        "id": "IN-OD-05", "name": "Teherai Manganese Mine", "operator": "Private lessee", "state": "Odisha", "district": "Sundargarh",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 21.936, "lon": 85.176,
        "capacityKt": 65, "gradeMn": 26.6, "reserveMt": 1.9, "commissioned": 2010, "depthM": 32, "phosphorusP": 0.09,
        "confidence": "low", "source": "Odisha Steel & Mines record",
    },
    {
        "id": "IN-OD-06", "name": "Orahuri Manganese Block", "operator": "Auctioned (2022)", "state": "Odisha", "district": "Sundargarh",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 21.978, "lon": 85.243,
        "capacityKt": 150, "gradeMn": 28.5, "reserveMt": 5.8, "commissioned": 2025, "depthM": 45, "phosphorusP": 0.07,
        "confidence": "low", "source": "Ministry of Mines auction block",
    },
    {
        "id": "IN-OD-07", "name": "Bhanjikusum Manganese Block", "operator": "Auctioned (2022)", "state": "Odisha", "district": "Sundargarh",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 21.989, "lon": 85.267,
        "capacityKt": 130, "gradeMn": 28.0, "reserveMt": 4.9, "commissioned": 2025, "depthM": 48, "phosphorusP": 0.07,
        "confidence": "low", "source": "Ministry of Mines auction block",
    },
    {
        "id": "IN-OD-08", "name": "Roida-D Manganese Block", "operator": "Auctioned (2022)", "state": "Odisha", "district": "Keonjhar",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.012, "lon": 85.318,
        "capacityKt": 120, "gradeMn": 27.6, "reserveMt": 4.2, "commissioned": 2025, "depthM": 42, "phosphorusP": 0.08,
        "confidence": "low", "source": "Ministry of Mines auction block",
    },
    {
        "id": "IN-OD-09", "name": "Kalimati Manganese Mine", "operator": "Private lessee", "state": "Odisha", "district": "Keonjhar",
        "belt": "Joda–Barbil", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.067, "lon": 85.421,
        "capacityKt": 80, "gradeMn": 28.8, "reserveMt": 2.7, "commissioned": 1975, "depthM": 50, "phosphorusP": 0.07,
        "confidence": "low", "source": "IBM lease list",
    },
    {
        "id": "IN-OD-10", "name": "Nishikhal Manganese Deposit", "operator": "Odisha Mining Corp (OMC)", "state": "Odisha", "district": "Koraput",
        "belt": "Eastern Ghats", "oreType": "kodurite", "miningMethod": "opencast", "lat": 19.203, "lon": 83.412,
        "capacityKt": 110, "gradeMn": 26.0, "reserveMt": 4.6, "commissioned": 1985, "depthM": 55, "phosphorusP": 0.12,
        "confidence": "medium", "source": "GSI memoir; OMC",
    },
    {
        "id": "IN-OD-11", "name": "Bandhagaon Manganese Deposit", "operator": "State lease", "state": "Odisha", "district": "Kalahandi",
        "belt": "Eastern Ghats", "oreType": "kodurite", "miningMethod": "opencast", "lat": 19.784, "lon": 83.211,
        "capacityKt": 60, "gradeMn": 24.5, "reserveMt": 2.3, "commissioned": 1992, "depthM": 40, "phosphorusP": 0.13,
        "confidence": "low", "source": "GSI district memoir (indicative)",
    },

    # ── Andhra Pradesh (Vizianagaram–Visakhapatnam belt) ──────────────────
    {
        "id": "IN-AP-01", "name": "Garividi Manganese Mine", "operator": "Private lessee", "state": "Andhra Pradesh", "district": "Vizianagaram",
        "belt": "Vizianagaram–Visakhapatnam", "oreType": "kodurite", "miningMethod": "opencast", "lat": 18.351, "lon": 83.553,
        "capacityKt": 140, "gradeMn": 29.0, "reserveMt": 5.4, "commissioned": 1955, "depthM": 50, "phosphorusP": 0.10,
        "confidence": "high", "source": "GSI/SCIRP deposit study",
    },
    {
        "id": "IN-AP-02", "name": "Garbham (Mango Tope) Manganese Mine", "operator": "Private lessee", "state": "Andhra Pradesh", "district": "Vizianagaram",
        "belt": "Vizianagaram–Visakhapatnam", "oreType": "kodurite", "miningMethod": "opencast", "lat": 18.408, "lon": 83.446,
        "capacityKt": 120, "gradeMn": 30.1, "reserveMt": 4.8, "commissioned": 1958, "depthM": 55, "phosphorusP": 0.09,
        "confidence": "high", "source": "MoEF EC document (10.52 ha lease)",
    },
    {
        "id": "IN-AP-03", "name": "Koduru Manganese Mine", "operator": "Private lessee", "state": "Andhra Pradesh", "district": "Vizianagaram",
        "belt": "Vizianagaram–Visakhapatnam", "oreType": "kodurite", "miningMethod": "opencast", "lat": 18.302, "lon": 83.508,
        "capacityKt": 110, "gradeMn": 28.6, "reserveMt": 4.1, "commissioned": 1962, "depthM": 48, "phosphorusP": 0.11,
        "confidence": "high", "source": "GSI mineralogy study, Koduru",
    },
    {
        "id": "IN-AP-04", "name": "Avagudem Manganese Mine", "operator": "Private lessee", "state": "Andhra Pradesh", "district": "Vizianagaram",
        "belt": "Vizianagaram–Visakhapatnam", "oreType": "kodurite", "miningMethod": "opencast", "lat": 18.256, "lon": 83.561,
        "capacityKt": 95, "gradeMn": 27.9, "reserveMt": 3.6, "commissioned": 1970, "depthM": 44, "phosphorusP": 0.12,
        "confidence": "medium", "source": "IJSRP mining-geology study, Avagudem",
    },
    {
        "id": "IN-AP-05", "name": "Devada Manganese Deposit", "operator": "State lease", "state": "Andhra Pradesh", "district": "Vizianagaram",
        "belt": "Vizianagaram–Visakhapatnam", "oreType": "kodurite", "miningMethod": "opencast", "lat": 18.281, "lon": 83.487,
        "capacityKt": 70, "gradeMn": 26.4, "reserveMt": 2.7, "commissioned": 1980, "depthM": 40, "phosphorusP": 0.12,
        "confidence": "low", "source": "State DMG record",
    },
    {
        "id": "IN-AP-06", "name": "Kondapalli Manganese Deposit", "operator": "Private lessee", "state": "Andhra Pradesh", "district": "Krishna",
        "belt": "Eastern Ghats", "oreType": "kodurite", "miningMethod": "opencast", "lat": 16.618, "lon": 80.532,
        "capacityKt": 55, "gradeMn": 25.2, "reserveMt": 1.8, "commissioned": 1985, "depthM": 35, "phosphorusP": 0.14,
        "confidence": "low", "source": "GSI district memoir (indicative)",
    },

    # ── Telangana (Adilabad) ──────────────────────────────────────────────
    {
        "id": "IN-TG-01", "name": "Adilabad Manganese Deposit", "operator": "State lease", "state": "Telangana", "district": "Adilabad",
        "belt": "Eastern Ghats", "oreType": "kodurite", "miningMethod": "opencast", "lat": 19.674, "lon": 78.532,
        "capacityKt": 60, "gradeMn": 25.8, "reserveMt": 2.4, "commissioned": 1978, "depthM": 40, "phosphorusP": 0.13,
        "confidence": "low", "source": "SCIRP deposit study (Adilabad)",
    },
    {
        "id": "IN-TG-02", "name": "Nirmal Manganese Deposit", "operator": "State lease", "state": "Telangana", "district": "Nirmal",
        "belt": "Eastern Ghats", "oreType": "kodurite", "miningMethod": "opencast", "lat": 19.096, "lon": 78.344,
        "capacityKt": 45, "gradeMn": 24.9, "reserveMt": 1.6, "commissioned": 1985, "depthM": 38, "phosphorusP": 0.14,
        "confidence": "low", "source": "State DMG record (indicative)",
    },

    # ── Gujarat (Panchmahal & Vadodara) ───────────────────────────────────
    {
        "id": "IN-GJ-01", "name": "Shivrajpur Manganese Mine", "operator": "Gujarat Mineral Development Corp (GMDC)", "state": "Gujarat", "district": "Panchmahal",
        "belt": "Panchmahal", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.502, "lon": 73.604,
        "capacityKt": 130, "gradeMn": 28.4, "reserveMt": 4.7, "commissioned": 1972, "depthM": 45, "phosphorusP": 0.08,
        "confidence": "high", "source": "GMDC minerals disclosure",
    },
    {
        "id": "IN-GJ-02", "name": "Pani Manganese Mine", "operator": "Gujarat Mineral Development Corp (GMDC)", "state": "Gujarat", "district": "Panchmahal",
        "belt": "Panchmahal", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.481, "lon": 73.633,
        "capacityKt": 80, "gradeMn": 27.1, "reserveMt": 2.8, "commissioned": 1978, "depthM": 40, "phosphorusP": 0.09,
        "confidence": "medium", "source": "GMDC operations",
    },
    {
        "id": "IN-GJ-03", "name": "Bapodar Manganese Deposit", "operator": "Private lessee", "state": "Gujarat", "district": "Panchmahal",
        "belt": "Panchmahal", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.517, "lon": 73.578,
        "capacityKt": 50, "gradeMn": 25.9, "reserveMt": 1.7, "commissioned": 1988, "depthM": 34, "phosphorusP": 0.10,
        "confidence": "low", "source": "State DMG record (indicative)",
    },
    {
        "id": "IN-GJ-04", "name": "Kajli Manganese Deposit", "operator": "Private lessee", "state": "Gujarat", "district": "Vadodara",
        "belt": "Panchmahal", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.311, "lon": 73.746,
        "capacityKt": 40, "gradeMn": 24.6, "reserveMt": 1.3, "commissioned": 1995, "depthM": 30, "phosphorusP": 0.11,
        "confidence": "low", "source": "State DMG record (indicative)",
    },

    # ── Madhya Pradesh (other districts) ──────────────────────────────────
    {
        "id": "IN-MP-07", "name": "Chhindwara Manganese Deposit", "operator": "State lease", "state": "Madhya Pradesh", "district": "Chhindwara",
        "belt": "Sausar", "oreType": "gondite", "miningMethod": "opencast", "lat": 22.057, "lon": 78.938,
        "capacityKt": 70, "gradeMn": 26.5, "reserveMt": 2.9, "commissioned": 1975, "depthM": 45, "phosphorusP": 0.10,
        "confidence": "low", "source": "GSI memoir (indicative)",
    },
    {
        "id": "IN-MP-08", "name": "Manegaon Manganese Deposit", "operator": "State lease", "state": "Madhya Pradesh", "district": "Jabalpur",
        "belt": "Sausar", "oreType": "gondite", "miningMethod": "opencast", "lat": 23.048, "lon": 79.918,
        "capacityKt": 55, "gradeMn": 25.4, "reserveMt": 2.1, "commissioned": 1980, "depthM": 42, "phosphorusP": 0.11,
        "confidence": "low", "source": "GSI memoir (indicative)",
    },
    {
        "id": "IN-MP-09", "name": "Khandwa (Nimar) Manganese Deposit", "operator": "State lease", "state": "Madhya Pradesh", "district": "Khandwa",
        "belt": "Sausar", "oreType": "gondite", "miningMethod": "opencast", "lat": 21.825, "lon": 76.352,
        "capacityKt": 45, "gradeMn": 24.1, "reserveMt": 1.5, "commissioned": 1985, "depthM": 36, "phosphorusP": 0.12,
        "confidence": "low", "source": "GSI memoir (indicative)",
    },

    # ── Rajasthan (Banswara & Udaipur) ────────────────────────────────────
    {
        "id": "IN-RJ-01", "name": "Banswara Manganese Belt (Gararia–Rupakhedi)", "operator": "State lease", "state": "Rajasthan", "district": "Banswara",
        "belt": "Banswara", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 23.251, "lon": 74.336,
        "capacityKt": 60, "gradeMn": 26.9, "reserveMt": 2.6, "commissioned": 1970, "depthM": 55, "phosphorusP": 0.10,
        "confidence": "medium", "source": "JGSI Banswara belt study (23°10′–23°20′N)",
    },
    {
        "id": "IN-RJ-02", "name": "Udaipur Manganese Deposit", "operator": "State lease", "state": "Rajasthan", "district": "Udaipur",
        "belt": "Aravalli", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 24.585, "lon": 73.712,
        "capacityKt": 35, "gradeMn": 23.8, "reserveMt": 1.1, "commissioned": 1985, "depthM": 40, "phosphorusP": 0.13,
        "confidence": "low", "source": "State DMG record (indicative)",
    },

    # ── Jharkhand (West Singhbhum) ────────────────────────────────────────
    {
        "id": "IN-JH-01", "name": "Noamundi Manganese Mine", "operator": "Tata Steel Ltd", "state": "Jharkhand", "district": "West Singhbhum",
        "belt": "Singhbhum", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.152, "lon": 85.504,
        "capacityKt": 90, "gradeMn": 27.3, "reserveMt": 3.2, "commissioned": 1965, "depthM": 48, "phosphorusP": 0.09,
        "confidence": "medium", "source": "IBM lease list; Tata Steel",
    },
    {
        "id": "IN-JH-02", "name": "Barajamda Manganese Deposit", "operator": "Private lessee", "state": "Jharkhand", "district": "West Singhbhum",
        "belt": "Singhbhum", "oreType": "sedimentary", "miningMethod": "opencast", "lat": 22.113, "lon": 85.441,
        "capacityKt": 50, "gradeMn": 25.5, "reserveMt": 1.7, "commissioned": 1980, "depthM": 38, "phosphorusP": 0.11,
        "confidence": "low", "source": "GSI district memoir (indicative)",
    },

    # ── Goa ───────────────────────────────────────────────────────────────
    {
        "id": "IN-GA-01", "name": "Sanvordem Manganese Deposit", "operator": "Private lessee", "state": "Goa", "district": "South Goa",
        "belt": "Goa", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.262, "lon": 74.121,
        "capacityKt": 40, "gradeMn": 22.8, "reserveMt": 1.4, "commissioned": 1960, "depthM": 30, "phosphorusP": 0.14,
        "confidence": "low", "source": "IBM State review (indicative)",
    },
    {
        "id": "IN-GA-02", "name": "Cudnem Manganese Deposit", "operator": "Private lessee", "state": "Goa", "district": "North Goa",
        "belt": "Goa", "oreType": "lateritic", "miningMethod": "opencast", "lat": 15.503, "lon": 73.921,
        "capacityKt": 30, "gradeMn": 21.6, "reserveMt": 1.0, "commissioned": 1965, "depthM": 28, "phosphorusP": 0.15,
        "confidence": "low", "source": "IBM State review (indicative)",
    },

    # ── Maharashtra (other lessees) ───────────────────────────────────────
    {
        "id": "IN-MH-07", "name": "Pauni Manganese Deposit", "operator": "Private lessee", "state": "Maharashtra", "district": "Bhandara",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "opencast", "lat": 20.789, "lon": 80.113,
        "capacityKt": 45, "gradeMn": 25.0, "reserveMt": 1.6, "commissioned": 1985, "depthM": 42, "phosphorusP": 0.11,
        "confidence": "low", "source": "State DMG record (indicative)",
    },
    {
        "id": "IN-MH-08", "name": "Mansar Manganese Deposit", "operator": "Private lessee", "state": "Maharashtra", "district": "Nagpur",
        "belt": "Nagpur–Bhandara", "oreType": "gondite", "miningMethod": "underground", "lat": 21.396, "lon": 79.289,
        "capacityKt": 60, "gradeMn": 26.1, "reserveMt": 2.0, "commissioned": 1982, "depthM": 140, "phosphorusP": 0.10,
        "confidence": "low", "source": "State DMG record (indicative)",
    },
]


def _derive_stats() -> Dict[str, Any]:
    """Derived national aggregates shown on the training screen."""
    # ``new Set(...)`` — insertion order preserved via ``dict.fromkeys``.
    states = list(dict.fromkeys(m["state"] for m in MANGANESE_MINES))
    capacity_kt = 0.0
    reserve_mt = 0.0
    grade_sum = 0.0
    for m in MANGANESE_MINES:
        capacity_kt += m["capacityKt"]
        reserve_mt += m["reserveMt"]
        grade_sum += m["gradeMn"]
    grade = grade_sum / len(MANGANESE_MINES)
    underground = 0
    underground_kt = 0.0
    for m in MANGANESE_MINES:
        if m["miningMethod"] == "underground":
            underground += 1
            underground_kt += m["capacityKt"]
    return {
        "mineCount": len(MANGANESE_MINES),
        "stateCount": len(states),
        "capacityKt": capacity_kt,
        "capacityMt": capacity_kt / 1000,
        "reserveMt": reserve_mt,
        "meanGradeMn": grade,
        "undergroundCount": underground,
        "undergroundShare": underground_kt / capacity_kt,
    }


MANGANESE_STATS: Dict[str, Any] = _derive_stats()
