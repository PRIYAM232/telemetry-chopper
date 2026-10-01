package filterprocessor

// Rule enforcement status (issue #13). The old "rules_ignored" count lumped
// a deliberately paused rule together with one the collector cannot run, so
// it could not back the alert operators actually want: "a rule exists that
// is not being enforced". Every rule now gets exactly one state, with a
// machine-readable reason when it is not enforced.

// Rule states, also the values of the rule_status gauge's "state" label.
const (
	// The collector evaluates the rule on its signal.
	ruleStateEnforced = "enforced"
	// isActive is false: intentionally off, never an alert condition.
	ruleStatePaused = "paused"
	// The rule is malformed and fails open: bad regex, or a SAMPLE /
	// ROUTE / THROTTLE rule missing its parameter. A defect to fix.
	ruleStateInvalid = "invalid"
	// Well-formed, but this collector doesn't implement the action on the
	// rule's signal (e.g. SAMPLE on LOGS, REDACT on METRICS) or doesn't know
	// the action or signal at all (a newer control plane).
	ruleStateUnsupported = "unsupported"
)

// Reasons for the invalid and unsupported states: a fixed set, so they are
// safe as a metric label.
const (
	reasonRegexInvalid       = "regex_does_not_compile"
	reasonMissingSampleRate  = "missing_sample_rate"
	reasonMissingDestination = "missing_destination"
	reasonMissingRate        = "missing_throttle_rate"
	reasonActionNotSupported = "action_not_supported_for_signal"
	reasonUnknownSignal      = "unknown_signal"
)

// ruleStatus classifies a compiled rule. It must agree with the
// ruleApplies* gates, which remain the source of truth on the hot path:
// "enforced" is exactly "some ruleApplies* returns true".
func ruleStatus(rule *compiledRule) (state, reason string) {
	if !rule.IsActive {
		return ruleStatePaused, ""
	}
	if !conditionUsable(rule) {
		return ruleStateInvalid, reasonRegexInvalid
	}

	var supported bool
	switch rule.TargetSignal {
	case SignalTraces:
		if ruleAppliesTraces(rule) {
			return ruleStateEnforced, ""
		}
		supported = actionSupported(rule.ActionType, ActionDrop, ActionRedact, ActionExcludeIndex, ActionSample, ActionRoute, ActionThrottle)
	case SignalLogs:
		if ruleAppliesLogs(rule) {
			return ruleStateEnforced, ""
		}
		supported = actionSupported(rule.ActionType, ActionDrop, ActionRedact, ActionExcludeIndex, ActionRoute, ActionThrottle)
	case SignalMetrics:
		if ruleAppliesMetrics(rule) {
			return ruleStateEnforced, ""
		}
		supported = actionSupported(rule.ActionType, ActionDrop, ActionRoute, ActionThrottle)
	default:
		return ruleStateUnsupported, reasonUnknownSignal
	}

	if !supported {
		return ruleStateUnsupported, reasonActionNotSupported
	}
	// The action runs on this signal, so the gate failed on a missing
	// parameter.
	switch rule.ActionType {
	case ActionSample:
		return ruleStateInvalid, reasonMissingSampleRate
	case ActionRoute:
		return ruleStateInvalid, reasonMissingDestination
	case ActionThrottle:
		return ruleStateInvalid, reasonMissingRate
	}
	// Unreachable while the switch above lists every supported action whose
	// gate can fail; report it rather than claim it is enforced.
	return ruleStateUnsupported, reasonActionNotSupported
}

func actionSupported(action string, supported ...string) bool {
	for _, a := range supported {
		if action == a {
			return true
		}
	}
	return false
}
