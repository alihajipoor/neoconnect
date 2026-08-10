package neoxifyxray

import (
	"io"
	"strings"
)

// gomobile cannot expose io.Reader across the language boundary, so the
// config crosses as a string and is wrapped here rather than at the call
// site.
func newReader(s string) io.Reader { return strings.NewReader(s) }
