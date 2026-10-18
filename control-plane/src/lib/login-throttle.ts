// Sign-in throttling (issue #10): after MAX_FAILURES wrong passwords for one
// email within WINDOW_MS, further attempts for that email are refused until
// the oldest failure ages out. Keyed by email, not client IP: behind a
// reverse proxy every client can share one IP, and X-Forwarded-For is
// whatever the client says it is.
//
// In-process memory, so each control-plane replica throttles on its own and
// a restart forgets. That still caps online guessing at a few dozen
// attempts per window per replica; it is a speed bump, not a lockout.

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
// Bounds memory if someone sprays random emails.
const MAX_TRACKED = 10_000;

const failures = new Map<string, number[]>();

function recent(email: string, now: number): number[] {
  const kept = (failures.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length) failures.set(email, kept);
  else failures.delete(email);
  return kept;
}

/** Milliseconds until `email` may try again, or 0 if it may try now. */
export function signInRetryAfterMs(email: string, now = Date.now()): number {
  const kept = recent(email, now);
  if (kept.length < MAX_FAILURES) return 0;
  return WINDOW_MS - (now - kept[0]);
}

export function recordSignInFailure(email: string, now = Date.now()): void {
  if (!failures.has(email) && failures.size >= MAX_TRACKED) {
    // Evict the oldest-inserted entry; Map iterates in insertion order.
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(email, [...recent(email, now), now]);
}

export function clearSignInFailures(email: string): void {
  failures.delete(email);
}
