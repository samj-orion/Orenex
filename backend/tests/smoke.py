"""End-to-end smoke test for the ORENEX Python engine.

Run with::

    python -m tests.smoke          # verbose unittest
    python tests/smoke.py          # same

It exercises every facade function and asserts that the result is strict-JSON
serialisable. The heavy layers (reserves/prospectivity/operations/models) build
lazily on first use, so this takes a minute or two.
"""

from __future__ import annotations

import json
import unittest

from orenex import api, engine


class EngineSmoke(unittest.TestCase):
    def _jsonable(self, obj):
        """Every endpoint must survive a strict JSON round-trip."""
        blob = json.dumps(engine.to_jsonable(obj), allow_nan=False)
        self.assertGreater(len(blob), 2)
        return json.loads(blob)

    def test_health(self):
        h = engine.health()
        self.assertEqual(h["status"], "ok")
        self.assertIn("version", h)

    def test_overview(self):
        o = self._jsonable(engine.overview())
        self.assertEqual(len(o["mines"]), 3)
        self.assertGreater(o["occurrenceCount"], 0)
        self.assertGreater(o["targetCount"], 0)
        self.assertGreater(o["terrain"]["nx"], 0)

    def test_geology(self):
        g = self._jsonable(engine.geology_layer())
        self.assertGreaterEqual(len(g["units"]), 1)
        self.assertGreaterEqual(len(g["structures"]), 1)
        self.assertGreaterEqual(len(g["occurrences"]), 1)

    def test_terrain_grid(self):
        t = self._jsonable(engine.terrain_grid(8))
        self.assertEqual(t["step"], 8)
        self.assertEqual(len(t["dem"]), t["height"])
        self.assertEqual(len(t["dem"][0]), t["width"])

    def test_prospectivity(self):
        p = self._jsonable(engine.prospectivity_summary())
        self.assertEqual(p["nx"], 132)  # NX from prospectivity.ts
        self.assertEqual(len(p["features"]), p["featureCount"])
        self.assertIn("fit", p)
        self.assertEqual(len(p["targets"]), p["targetCount"])

    def test_prospectivity_grid(self):
        g = self._jsonable(engine.prospectivity_grid(16))
        self.assertGreater(len(g["cells"]), 0)
        for c in g["cells"][:5]:
            self.assertGreaterEqual(c["p"], 0.0)
            self.assertLessEqual(c["p"], 1.0)

    def test_targets(self):
        t = self._jsonable(engine.targets())
        self.assertGreater(len(t["targets"]), 0)
        for key in ("id", "priority", "rank", "probability", "depthTopM"):
            self.assertIn(key, t["targets"][0])

    def test_reserves(self):
        r = self._jsonable(engine.reserves_all())
        self.assertEqual(len(r["mines"]), 3)
        for s in r["mines"]:
            self.assertGreaterEqual(s["totalTonnes"], 0)
            self.assertIn("unfc", s)

    def test_operations(self):
        o = self._jsonable(engine.operations_summary())
        self.assertGreater(o["fleetCount"], 0)
        self.assertGreater(o["productionShifts"], 0)
        self.assertEqual(len(o["byMine"]), 3)

    def test_forecast(self):
        f = self._jsonable(engine.forecast_mine("MNE-BAL", horizon=30))
        self.assertEqual(len(f["days"]), 30)
        self.assertIn("pShort30", f)
        self.assertGreaterEqual(f["pShort30"], 0.0)
        self.assertLessEqual(f["pShort30"], 1.0)

    def test_alerts(self):
        a = self._jsonable(engine.alerts())
        self.assertIsInstance(a["alerts"], list)

    def test_backtest(self):
        b = self._jsonable(engine.backtest_mine("MNE-BAL"))
        self.assertGreater(len(b["origins"]), 0)
        self.assertIn("coverage80Pct", b)

    def test_backtest_portfolio(self):
        p = self._jsonable(engine.backtest_portfolio())
        self.assertEqual(len(p["perMine"]), 3)

    def test_reconciliation(self):
        r = self._jsonable(engine.reconciliation_summary())
        self.assertEqual(len(r["mines"]), 3)
        self.assertIn("oci", r["company"])

    def test_validation(self):
        v = self._jsonable(engine.validation_summary())
        self.assertIn("roc", v)
        self.assertIn("calibration", v)

    def test_models(self):
        m = self._jsonable(engine.model_registry())
        ids = [x["id"] for x in m["models"]]
        self.assertIn("m1", ids)
        self.assertIn("mn50", ids)
        self.assertGreater(len(m["sources"]), 0)

    def test_manganese(self):
        d = self._jsonable(engine.manganese())
        self.assertEqual(len(d["mines"]), 50)
        self.assertEqual(d["stats"]["mineCount"], 50)

    def test_manganese_model(self):
        t = self._jsonable(engine.manganese_model())
        self.assertEqual(t["rows"], 50)
        self.assertEqual(t["modelId"], "mn50")
        r2 = t["regression"]["metrics"]["r2"]
        self.assertGreater(r2, 0.5)
        auc = t["classification"]["metrics"]["auc"]
        self.assertGreater(auc, 0.5)

    def test_assistant(self):
        a = self._jsonable(engine.assistant_ask("Why is the top target P1?"))
        self.assertIn("blocks", a)
        self.assertGreater(len(a["blocks"]), 0)

    def test_to_jsonable_handles_arrays_and_nan(self):
        from array import array

        out = engine.to_jsonable({"a": array("f", [1.0, 2.5]), "nan": float("nan"), "inf": float("inf")})
        self.assertEqual(out["a"], [1.0, 2.5])
        self.assertIsNone(out["nan"])
        self.assertIsNone(out["inf"])
        json.dumps(out, allow_nan=False)

    def test_router(self):
        self.assertEqual(api.route("GET", "/health", {}, None)["status"], "ok")
        idx = api.route("GET", "/", {}, None)
        self.assertGreater(len(idx["endpoints"]), 5)
        with self.assertRaises(api._NotFound):
            api.route("GET", "/nope", {}, None)
        a = api.route("POST", "/assistant", {}, {"q": "What is the reserve at Balaghat?", "mineId": "MNE-BAL"})
        self.assertIn("blocks", a)


if __name__ == "__main__":
    unittest.main(verbosity=2)
