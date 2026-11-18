# ORENEX backend port — conventions

This package (`orenex/`) is a **dependency-free, standard-library-only Python port**
of the ORENEX frontend engine (`../frontend/src/core/*.ts`). The two are
intentionally independent: the frontend keeps and uses its TypeScript engine, and
this is a separate reference service.

Every ported module must follow these rules so the nine modules written in
parallel fit together. **Read this whole file before writing code.**

## Ground rules

* **Standard library only.** No `numpy`, no third-party packages. Allowed:
  `math`, `array`, `dataclasses`, `typing`, `json`, `copy`, `itertools`,
  `functools`, `collections`, `datetime`, `struct`, `random` (avoid unless the TS
  uses it — it does not).
* **Deterministic parity.** The same seed must produce the same numbers as the
  TypeScript. Port arithmetic literally. Never substitute a "nicer" algorithm.
* Keep the code readable and in the same order as the TS so a reviewer can diff.

## Naming

| Kind | Convention | Example |
|------|-----------|---------|
| Functions / methods | snake_case of the TS name | `makeRng` → `make_rng` |
| Module-level constants | keep the TS name (already UPPER_SNAKE usually) | `GEO_UNITS`, `NX`, `NY` |
| Local variables / params | snake_case | `maxE` → `max_e` |
| **Data record keys** (dict keys mirroring TS object fields) | **EXACT TypeScript spelling (camelCase)** | `{"gradePctMn": 30.1, "lat": 21.9}` |

The last rule matters: JSON coming out of this service should have the *same
field names* as the frontend, so the two engines are directly comparable. Only
Python identifiers get snake_cased; **payload keys do not**.

## Translating TypeScript

* `interface X { … }` / `type X = { … }` → build plain **`dict`** records.
  Document the shape in a docstring. Do **not** invent a class.
* `type X = 'a' | 'b' | null` → `str | None`; keep the literal string values.
* `someFn<T>(…)` generics → just type hints, or omit.
* `Math.*` → `math.*` **with these exact substitutions**:
  * `Math.round(x)` → `math.floor(x + 0.5)` (JS rounds half **up**, Python's
    `round()` is banker's rounding — do **not** use `round()` for this).
  * `Math.trunc(x)` → `int(x)`   • `Math.sign(x)` → `(x > 0) - (x < 0)`
  * `Math.max/min/abs/sqrt/sin/cos/tan/log/exp/pow/hypot/atan2/floor/ceil/pi/e`
    map directly.
* `x ** y` → `x ** y`.
* `Math.min(Math.max(v, lo), hi)` → `clamp(v, lo, hi)` from `.noise` where it is
  already imported, otherwise inline.
* Template literals → f-strings.
* `arr.map(f)` → list comprehension · `arr.filter(f)` → comprehension with `if`
  · `arr.reduce(f, init)` → `functools.reduce` or a loop · `arr.slice(a, b)` →
  `arr[a:b]` · `arr.includes(x)` → `x in arr` · `arr.indexOf(x)` → `arr.index(x)`
  (guard with `if x in arr`).
* `arr.sort((a, b) => a - b)` → `arr.sort()` (numeric sort is the default in
  Python). **Never** rely on JS default string sort.
* `for (const x of arr)` → `for x in arr` · `for (let i = 0; i < n; i++)` →
  `for i in range(n)`.
* `new Map()` → `dict`. `map.get(k)` → `d.get(k)`; `map.has(k)` → `k in d`.
  `[...map.values()]` → `list(d.values())`. `Map` iteration order is insertion
  order in both languages.
* `new Set()` → preserve **insertion order and de-duplication** with a `dict`
  used as an ordered set (`d[k] = None`), or `list(dict.fromkeys(iterable))`.
  Do **not** use a bare Python `set` where order matters.
* `{...a, ...b}` → `{**a, **b}` · `structuredClone(x)` → `copy.deepcopy(x)`.
* `JSON.parse(JSON.stringify(x))` → `copy.deepcopy(x)`.
* `null`/`undefined` → `None`.
* `!x` on a value → `not x` (mind that `0` and `""` are falsy in both).
* `x?.y` → `(x.get("y") if x else None)`.
* `a || b` on values → `a if a else b` **only** if the TS relies on JS
  falsiness; if it means "nullish", use `a if a is not None else b`.
* `toFixed(n)` → `f"{x:.{n}f}"` (guard `NaN` first).
* `padStart(2,'0')` → `f"{x:02d}"` (numbers) or `str(x).rjust(n, '0')`.

## Typed arrays (`Float32Array` etc.)

Use Python's `array` module so storage rounding matches the JS typed array:

| TypeScript | Python |
|-----------|--------|
| `Float32Array` | `array.array('f', […])` |
| `Float64Array` | `array.array('d', […])` |
| `Uint8Array` | `array.array('B', […])` |
| `Uint16Array` | `array.array('H', […])` |
| `Uint32Array` | `array.array('I', […])` |
| `Int32Array` | `array.array('i', […])` |

`array('f')` stores IEEE-754 single precision, so a value written into it is
rounded exactly like a JS `Float32Array` cell — that preserves numeric parity.
Reading it back gives a Python float. Indexing/slicing/`len`/assignment work the
same as a list. When a plain list is fine (small arrays that are never stored as
`float32`), use a list.

## Imports between ported modules

Use relative imports matching the module map:

| TypeScript | Python module |
|-----------|---------------|
| `rng.ts` | `.rng` |
| `noise.ts` | `.noise` |
| `clock.ts` | `.clock` |
| `format.ts` | `.format` |
| `geo.ts` | `.geo` |
| `geology.ts` | `.geology` |
| `prospectivity.ts` | `.prospectivity` |
| `reserves.ts` | `.reserves` |
| `operations.ts` | `.operations` |
| `stageModel.ts` | `.stage_model` |
| `forecast.ts` | `.forecast` |
| `reconciliation.ts` | `.reconciliation` |
| `validation.ts` | `.validation` |
| `backtest.ts` | `.backtest` |
| `assistant.ts` | `.assistant` |
| `models.ts` | `.models` |
| `manganeseIndia.ts` | `.manganese_india` |
| `trainer.ts` | `.trainer` |
| `manganeseModel.ts` | `.manganese_model` |

Foundation modules **already exist** and export exactly these names:

* `.rng` — `MASK`, `make_rng(seed)`, `gaussian(rng, mean=0, sd=1)`,
  `pick(rng, items)`, `range_(rng, lo, hi)`, `quantile_sorted(sorted, q)`,
  `norm_inv(p)`.
  *(Note `range_` not `range`. `invNorm` is `norm_inv`.)*
* `.noise` — `PERM_SIZE`, `make_noise_2d(seed)`, `make_fbm(seed, octaves=5,
  lacunarity=2.03, gain=0.5)`, `make_ridged(seed, octaves=5)`, `clamp(v, lo, hi)`,
  `smoothstep(a, b, x)`, `sample_field(field, w, h, u, v)`.
* `.clock` — `now()`, `now_iso()`.
* `.format` — `num`, `tonnes`, `pct`, `grade`, `metres`, `signed`, `MONTHS`,
  `NOW`, `fmt_date_short(d)`, `iso_date(d)`, `add_days(d, days)`,
  `monsoon_factor(d)`.
* `.geo` — `AOI` (dict), `AOI_WIDTH_M`, `AOI_HEIGHT_M`, `norm_x`, `norm_y`,
  `denorm_x`, `denorm_y`, `utm44_to_lonlat(e, n)`.

When you import a sibling module you must **import the snake_case names** (e.g.
`from .geology import build_units, GEO_UNITS`). If you are unsure of a sibling's
exact exported name, open its `.ts` source and snake_case the export yourself —
do not guess.

## Module public surface

Port **every** `export` in the source file (functions, consts, types-as-records).
Do not drop exports because nothing in your module uses them — the HTTP API and
other modules may. Do not add exports that do not exist in the TS.

At the top of each file, add a short docstring naming the source file it ports,
e.g. `"""Port of ``prospectivity.ts``."""`.

## Verification you must run

At minimum, syntax-check every file you write:

```
python -m py_compile orenex/<module>.py
```

(run from `backend/`). If the modules it imports already exist on disk you may
also do a runtime import check, but do **not** block on modules that are still
being written in parallel — syntax check is enough, integration is handled
centrally.
