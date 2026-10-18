package filterprocessor

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Local rules file: standalone mode without a control plane.
//
// With rules_file set, the processor reads its ruleset from a YAML file
// instead of polling sync_endpoint, so a single otelcol-chopper binary (or
// package) does useful work on its own: install, edit rules.yaml, done. The
// file is re-read every rules_file_check_interval and a changed, valid file
// replaces the ruleset without a restart.
//
// Unlike rules from the control plane, which already validated them and
// where the collector fails open per rule, a rules file is hand-written, so
// it is validated strictly: one mistake rejects the whole file with an error
// naming the rule and the problem. At startup (and in `otelcol validate`)
// that fails the collector; at runtime the last good ruleset stays in force.
//
// Example:
//
//	rules:
//	  - name: drop-health-checks
//	    signal: traces
//	    action: drop
//	    when: { field: http.route, op: equals, value: /healthz }
//	  - name: keep-10-percent
//	    signal: traces
//	    action: sample
//	    sample_rate: 0.1

// maxRulesFileBytes caps how much of the file is read, like
// maxSyncResponseBytes does for the policy endpoint.
const maxRulesFileBytes = maxSyncResponseBytes

// identifierRE is the shape the control plane enforces for ROUTE
// destinations and THROTTLE group-by keys: they must match a routing table
// entry or an attribute key exactly, so free text only manufactures typos.
var identifierRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$`)

type rulesFileDoc struct {
	Rules []fileRule `yaml:"rules"`
}

type fileRule struct {
	Name   string `yaml:"name"`
	Signal string `yaml:"signal"`
	Action string `yaml:"action"`
	// Enabled defaults to true; false keeps the rule in the file, paused.
	Enabled *bool          `yaml:"enabled"`
	When    *fileCondition `yaml:"when"`

	SampleRate      *float64 `yaml:"sample_rate"`
	SampleScope     string   `yaml:"sample_scope"`
	Destination     string   `yaml:"destination"`
	ThrottleRate    *int     `yaml:"throttle_rate"`
	ThrottleGroupBy string   `yaml:"throttle_group_by"`
}

type fileCondition struct {
	Field string `yaml:"field"`
	Op    string `yaml:"op"`
	// Value is a YAML scalar of any type: `value: 404` and `value: "404"`
	// both mean the string 404, which matches Str("404") and Int(404)
	// attributes alike.
	// Kind is 0 when the key is absent.
	Value      yaml.Node `yaml:"value"`
	IgnoreCase bool      `yaml:"ignore_case"`
}

// loadRulesFile reads and validates the rules file at path, returning the
// ruleset in wire form plus the raw bytes (hashed by the reload loop to
// skip unchanged files).
func loadRulesFile(path string) ([]PolicyRule, []byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, fmt.Errorf("rules_file: %w", err)
	}
	defer f.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(io.LimitReader(f, maxRulesFileBytes+1)); err != nil {
		return nil, nil, fmt.Errorf("rules_file %s: %w", path, err)
	}
	if buf.Len() > maxRulesFileBytes {
		return nil, nil, fmt.Errorf("rules_file %s is larger than %d bytes", path, maxRulesFileBytes)
	}
	rules, err := parseRulesFile(buf.Bytes())
	if err != nil {
		return nil, nil, fmt.Errorf("rules_file %s: %w", path, err)
	}
	return rules, buf.Bytes(), nil
}

// parseRulesFile decodes and validates a rules file's contents.
func parseRulesFile(data []byte) ([]PolicyRule, error) {
	var doc rulesFileDoc
	dec := yaml.NewDecoder(bytes.NewReader(data))
	// A misspelled key (sample-rate, conditon) is an error, not a silently
	// ignored setting.
	dec.KnownFields(true)
	// io.EOF is an empty document: a valid file with no rules.
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}

	rules := make([]PolicyRule, 0, len(doc.Rules))
	seen := make(map[string]int, len(doc.Rules))
	for i := range doc.Rules {
		fr := &doc.Rules[i]
		rule, err := fr.toPolicyRule()
		if err != nil {
			if fr.Name != "" {
				return nil, fmt.Errorf("rule %d (%q): %w", i+1, fr.Name, err)
			}
			return nil, fmt.Errorf("rule %d: %w", i+1, err)
		}
		if first, dup := seen[rule.Name]; dup {
			return nil, fmt.Errorf("rule %d (%q): name already used by rule %d; names must be unique", i+1, rule.Name, first)
		}
		seen[rule.Name] = i + 1
		rules = append(rules, rule)
	}
	return rules, nil
}

// enumValue normalizes a lowercase file value (exclude_index) to the wire
// enum (EXCLUDE_INDEX), accepting either spelling.
func enumValue(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

func (fr *fileRule) toPolicyRule() (PolicyRule, error) {
	name := strings.TrimSpace(fr.Name)
	if name == "" {
		return PolicyRule{}, errors.New("name is required")
	}
	if len(name) > 128 {
		return PolicyRule{}, errors.New("name must be at most 128 characters")
	}

	signal := enumValue(fr.Signal)
	switch signal {
	case SignalTraces, SignalLogs, SignalMetrics:
	case "":
		return PolicyRule{}, errors.New("signal is required: traces, logs or metrics")
	default:
		return PolicyRule{}, fmt.Errorf("unknown signal %q: use traces, logs or metrics", fr.Signal)
	}

	action := enumValue(fr.Action)
	var allowed []string
	switch signal {
	case SignalTraces:
		allowed = []string{ActionDrop, ActionSample, ActionRedact, ActionRoute, ActionThrottle, ActionExcludeIndex}
	case SignalLogs:
		allowed = []string{ActionDrop, ActionRedact, ActionRoute, ActionThrottle, ActionExcludeIndex}
	case SignalMetrics:
		allowed = []string{ActionDrop, ActionRoute, ActionThrottle}
	}
	switch {
	case action == "":
		return PolicyRule{}, errors.New("action is required: drop, sample, redact, route, throttle or exclude_index")
	case !actionSupported(action, ActionDrop, ActionSample, ActionRedact, ActionRoute, ActionThrottle, ActionExcludeIndex):
		return PolicyRule{}, fmt.Errorf("unknown action %q: use drop, sample, redact, route, throttle or exclude_index", fr.Action)
	case !actionSupported(action, allowed...):
		return PolicyRule{}, fmt.Errorf("action %s is not supported for %s; %s supports %s",
			strings.ToLower(action), strings.ToLower(signal), strings.ToLower(signal), strings.ToLower(strings.Join(allowed, ", ")))
	}

	rule := PolicyRule{
		// signal/action/name: unique because names are, readable as the
		// rule_id metric label, and editing a rule's signal or action gives
		// it fresh counters instead of mislabeled ones (ruleStatsRegistry
		// keeps a rule's identity from first sight).
		ID:           strings.ToLower(signal+"/"+action+"/") + name,
		Name:         name,
		IsActive:     fr.Enabled == nil || *fr.Enabled,
		ActionType:   action,
		TargetSignal: signal,
	}

	// Action-specific settings: required for their action, rejected on any
	// other, so a setting can't silently do nothing.
	only := func(set bool, key, forAction string) error {
		if set && action != forAction {
			return fmt.Errorf("%s only applies to %s rules", key, strings.ToLower(forAction))
		}
		return nil
	}
	for _, err := range []error{
		only(fr.SampleRate != nil, "sample_rate", ActionSample),
		only(fr.SampleScope != "", "sample_scope", ActionSample),
		only(fr.Destination != "", "destination", ActionRoute),
		only(fr.ThrottleRate != nil, "throttle_rate", ActionThrottle),
		only(fr.ThrottleGroupBy != "", "throttle_group_by", ActionThrottle),
	} {
		if err != nil {
			return PolicyRule{}, err
		}
	}

	wholeTrace := false
	switch action {
	case ActionSample:
		if fr.SampleRate == nil {
			return PolicyRule{}, errors.New("sample_rate is required, the fraction of traces to keep, e.g. 0.1")
		}
		if r := *fr.SampleRate; math.IsNaN(r) || r <= 0 || r > 1 {
			return PolicyRule{}, fmt.Errorf("sample_rate must be greater than 0 and at most 1, got %v", r)
		}
		rule.SampleRate = fr.SampleRate
		// Whole traces by default, like new rules on the dashboard (issue #45).
		switch scope := enumValue(fr.SampleScope); scope {
		case "", SampleScopeTrace:
			rule.SampleScope = SampleScopeTrace
			wholeTrace = true
		case SampleScopeSpan:
			rule.SampleScope = SampleScopeSpan
		default:
			return PolicyRule{}, fmt.Errorf("unknown sample_scope %q: use trace or span", fr.SampleScope)
		}
	case ActionRoute:
		if !identifierRE.MatchString(fr.Destination) {
			return PolicyRule{}, errors.New("destination is required: 1-128 letters, digits, . _ / - matching a routing connector entry, e.g. cold-storage")
		}
		rule.TargetDestination = fr.Destination
	case ActionThrottle:
		if fr.ThrottleRate == nil || *fr.ThrottleRate < 1 || *fr.ThrottleRate > 1_000_000 {
			return PolicyRule{}, errors.New("throttle_rate is required: a whole number of records per second from 1 to 1000000")
		}
		rule.ThrottleRate = fr.ThrottleRate
		if fr.ThrottleGroupBy != "" {
			if !identifierRE.MatchString(fr.ThrottleGroupBy) {
				return PolicyRule{}, errors.New("throttle_group_by must be an attribute key: 1-128 letters, digits, . _ / -")
			}
			rule.ThrottleGroupBy = fr.ThrottleGroupBy
		}
	}

	if wholeTrace {
		if fr.When != nil {
			return PolicyRule{}, errors.New("a whole-trace sample rule samples every trace and has no condition; remove when, or set sample_scope: span to sample only matching spans")
		}
		// The control plane's convention for a condition-less rule.
		rule.ConditionOp = OpExists
		return rule, nil
	}
	if fr.When == nil {
		return PolicyRule{}, errors.New("when is required: the condition that selects records, e.g. when: { field: http.route, op: equals, value: /healthz }")
	}
	if err := fr.When.apply(&rule); err != nil {
		return PolicyRule{}, fmt.Errorf("when: %w", err)
	}
	return rule, nil
}

func (c *fileCondition) apply(rule *PolicyRule) error {
	field := strings.TrimSpace(c.Field)
	if field == "" {
		return errors.New("field is required, e.g. http.route, log.severity or metric.name")
	}
	op := enumValue(c.Op)
	if !actionSupported(op, OpEquals, OpContains, OpRegexMatch, OpExists, OpGreaterThan, OpLessThan) {
		if op == "" {
			return errors.New("op is required: equals, contains, regex_match, exists, greater_than or less_than")
		}
		return fmt.Errorf("unknown op %q: use equals, contains, regex_match, exists, greater_than or less_than", c.Op)
	}

	// `value:` with nothing after it decodes as a null scalar: no value.
	var value string
	if c.Value.Kind != 0 && c.Value.Tag != "!!null" {
		if c.Value.Kind != yaml.ScalarNode {
			return errors.New("value must be a single value, not a list or map")
		}
		value = c.Value.Value
	}
	if value == "" && op != OpExists {
		return fmt.Errorf("value is required for %s", strings.ToLower(op))
	}
	switch op {
	case OpExists:
		if value != "" {
			return errors.New("exists takes no value")
		}
	case OpGreaterThan, OpLessThan:
		if _, err := strconv.ParseFloat(value, 64); err != nil {
			return fmt.Errorf("%s needs a number value, got %q", strings.ToLower(op), value)
		}
	case OpRegexMatch:
		pattern := value
		if c.IgnoreCase {
			pattern = "(?i)" + pattern
		}
		// The same RE2 grammar the rule is compiled with: no lookaround or
		// backreferences.
		if _, err := regexp.Compile(pattern); err != nil {
			return fmt.Errorf("value is not a valid RE2 regular expression: %w", err)
		}
	}
	if c.IgnoreCase && !actionSupported(op, OpEquals, OpContains, OpRegexMatch) {
		return errors.New("ignore_case only applies to equals, contains and regex_match")
	}

	rule.ConditionField = field
	rule.ConditionOp = op
	rule.ConditionValue = value
	rule.ConditionIgnoreCase = c.IgnoreCase
	return nil
}
