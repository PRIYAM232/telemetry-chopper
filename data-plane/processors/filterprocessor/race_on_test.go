//go:build race

package filterprocessor

// raceEnabled reports whether the test binary was built with -race, which
// makes sync.Pool drop items at random and so skews allocation counts.
const raceEnabled = true
