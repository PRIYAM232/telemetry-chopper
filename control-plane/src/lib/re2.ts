// RE2 syntax checking for REGEX_MATCH condition values.
//
// The data plane compiles patterns with Go's regexp package (RE2 syntax), so
// a JS `new RegExp()` check is the wrong oracle: lookaround and
// backreferences pass in JS, then fail to compile in the collector, and the
// rule silently fails open. re2js is a port of RE2J, itself a port of Go's
// regexp parser, so its accept/reject decisions track the collector's.
//
// Measured against Go 1.26 regexp.Compile: 85 hand-picked edge cases agree
// exactly, and across 20,000 random patterns the only disagreements are a
// literal `{` followed by a quantifier (e.g. `{+`), which Go accepts and
// re2js rejects. That errs on the safe side: a pattern is never accepted here
// that the collector would drop, and escaping the brace (`\{+`) satisfies both.

import { RE2JS } from "re2js";

/**
 * Returns null when `pattern` compiles as RE2, else the parser's message,
 * worded like Go's (e.g. "error parsing regexp: invalid or unsupported Perl
 * syntax: `(?=`").
 */
export function re2SyntaxError(pattern: string): string | null {
  try {
    RE2JS.compile(pattern);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
