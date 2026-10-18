// Password rules, on their own so client forms can show them without
// bundling node:crypto from src/lib/password.ts.

export const MIN_PASSWORD_LENGTH = 12;
// Long enough for any passphrase, short enough that scrypt never sees a
// multi-megabyte form field.
export const MAX_PASSWORD_LENGTH = 256;

/** Returns why `password` is unacceptable, or null if it's fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}
