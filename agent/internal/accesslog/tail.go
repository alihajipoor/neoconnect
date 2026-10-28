package accesslog

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

// Tailer follows a file that something else appends to and logrotate
// rotates, handing back each complete line once.
//
// It starts at the end of the file as it was when the tailer was made.
// The site history is something customers are told about from the day
// it starts, so a fresh agent -- or an upgraded one -- must not read the
// day of access log already on disk and report it as if it had just
// happened.
//
// The file is opened afresh on every poll rather than held open. That
// costs an open and a stat every few seconds, and buys rotation of every
// kind for free: a renamed-away log is simply not the file at the path
// any more, and a deleted one is absent.
type Tailer struct {
	path    string
	maxRead int64

	// primed is false until the end of the file has been found. A file
	// that could not be read at start (permissions, say) is primed on the
	// first poll that can, at its end then -- never read from the top.
	primed bool
	offset int64
	// prev is the byte at offset-1 as it was when read. If the byte there
	// now is different, the file under this offset is not the one read:
	// it was truncated and has since grown back past where we were.
	prev byte
	// info identifies the file the offset belongs to, so a log replaced by
	// rename is noticed even when the new one is already longer.
	info fs.FileInfo
	// skipping discards input up to the next line end: the remainder of a
	// line that was already partly written when the tailer started, or of
	// one longer than maxRead.
	skipping bool

	buf []byte
}

// NewTailer returns a tailer positioned at the current end of path. A
// file that does not exist yet is fine: whatever is written to it later
// is new, and is read from its start. maxRead bounds how much one Poll
// reads.
func NewTailer(path string, maxRead int64) *Tailer {
	if maxRead <= 0 {
		maxRead = DefaultMaxReadBytes
	}
	t := &Tailer{path: path, maxRead: maxRead}
	_ = t.prime()
	return t
}

// prime moves the offset to the end of the file. Absence counts as
// primed at zero; any other failure leaves the tailer unprimed, to try
// again on the next poll.
func (t *Tailer) prime() error {
	f, err := os.Open(t.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.primed = true
			t.restart()
			return nil
		}
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	t.primed = true
	t.restart()
	t.info = info
	if size := info.Size(); size > 0 {
		var b [1]byte
		if _, err := f.ReadAt(b[:], size-1); err != nil && !errors.Is(err, io.EOF) {
			t.primed = false
			return err
		}
		t.offset, t.prev = size, b[0]
		// Xray writes each line with one write call, so this is almost
		// always a line end. If it is not, the next poll starts partway
		// through a line, and that fragment is not ours to parse.
		t.skipping = b[0] != '\n'
	}
	return nil
}

// restart forgets the position, so the next read starts at offset 0 of
// whatever file is at the path.
func (t *Tailer) restart() {
	t.offset, t.prev, t.info, t.skipping = 0, 0, nil, false
}

// Poll reads at most maxRead bytes of what has been appended since the
// last call and passes each complete line to fn, without its line end. A
// trailing line Xray has not finished writing is left for the next poll.
//
// An absent file is not an error: access logging can be off, and
// logrotate can be between moving the old file and Xray creating the
// new one. Poll reports nothing and looks again next time.
func (t *Tailer) Poll(fn func(line string)) error {
	if !t.primed {
		// Nothing is read on the poll that primes: the file's contents
		// at that moment are history from before the tailer could see
		// them, which is exactly what must not be shipped.
		return t.prime()
	}

	f, err := os.Open(t.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.restart()
			return nil
		}
		return fmt.Errorf("open %s: %w", t.path, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", t.path, err)
	}
	size := info.Size()

	switch {
	case t.info != nil && !os.SameFile(t.info, info):
		// Rotated by rename: a different file now has this name.
		t.restart()
	case size < t.offset:
		// copytruncate, which is how the installer's logrotate rule
		// rotates this file: same file, cut back to nothing.
		t.restart()
	case t.offset > 0:
		// Truncated and grown back past the old offset between two
		// polls. Rare -- it needs a small file and a busy node -- but
		// reading on from the old offset would start mid-line in the
		// new content and skip everything before it.
		var b [1]byte
		if _, err := f.ReadAt(b[:], t.offset-1); err != nil || b[0] != t.prev {
			t.restart()
		}
	}
	t.info = info

	if size <= t.offset {
		return nil
	}
	n := size - t.offset
	if n > t.maxRead {
		n = t.maxRead
	}
	if int64(cap(t.buf)) < n {
		t.buf = make([]byte, n)
	}
	buf := t.buf[:n]
	got, err := f.ReadAt(buf, t.offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read %s: %w", t.path, err)
	}
	data := buf[:got]

	consumed := 0
	if t.skipping {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			t.advance(data, len(data))
			return nil
		}
		consumed = i + 1
		t.skipping = false
	}

	rest := data[consumed:]
	if last := bytes.LastIndexByte(rest, '\n'); last >= 0 {
		for _, line := range bytes.Split(rest[:last], []byte{'\n'}) {
			fn(string(bytes.TrimSuffix(line, []byte{'\r'})))
		}
		consumed += last + 1
	} else if consumed == 0 && int64(got) == t.maxRead {
		// A whole read with no line end in it. No access line is that
		// long, and waiting for its end would stall the tailer for good,
		// so discard it up to wherever it does end.
		consumed = len(data)
		t.skipping = true
	}
	t.advance(data, consumed)
	return nil
}

func (t *Tailer) advance(data []byte, n int) {
	if n <= 0 {
		return
	}
	t.offset += int64(n)
	t.prev = data[n-1]
}
