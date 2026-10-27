package push

import "time"

// Fallback is the safety-net round interval while both push sources are live (PEP 0004 §2.5).
const Fallback = 60 * time.Second

// NextWait is how long the watch loop waits for a signal before running a round anyway.
// WHY: with a live hub and a healthy watcher every change arrives as a signal, so the timer only guards against a
// lost message; without either, the folder's configured interval is the only way changes are seen.
func NextWait(hubConnected, watcherHealthy bool, interval time.Duration) time.Duration {
	if hubConnected && watcherHealthy && interval < Fallback {
		return Fallback
	}
	return interval
}
