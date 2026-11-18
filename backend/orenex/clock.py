"""A single clock for the whole prototype (port of ``clock.ts``).

The demo needs "today" to be stable for the whole session — forecast days,
relative timestamps and audit entries must not disagree with each other — so the
instant is captured once and read everywhere.
"""

from __future__ import annotations

from datetime import datetime, timezone

# Captured once at import, exactly like the TypeScript module-level `new Date()`.
captured = datetime.now()


def to_iso(dt: datetime) -> str:
    """JavaScript ``Date#toISOString`` shape: ``YYYY-MM-DDTHH:MM:SS.mmmZ``."""
    if dt.tzinfo is None:
        dt = dt.astimezone(timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return to_iso(captured)


def now() -> datetime:
    return captured
