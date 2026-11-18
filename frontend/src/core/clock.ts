/**
 * A single clock for the whole prototype.
 *
 * The demo needs "today" to be stable for the whole session — forecast days,
 * relative timestamps and audit entries must not disagree with each other — so
 * the instant is captured once and read everywhere.
 */

const captured = new Date();

export function nowIso(): string {
  return captured.toISOString();
}
export function now(): Date {
  return captured;
}