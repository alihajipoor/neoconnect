//go:build !darwin

package neoxifyxray

// Android, and anything else the package is built for: no footprint is
// read there. The diagnostics are for the iOS extension, whose memory
// ceiling is what they watch.
func footprint() (current, peak int64) { return -1, -1 }

func availableMemory() int64 { return -1 }
