// Package ui holds <folder-sync-status>, the one sync view every app embeds (docs/API.md "The element").
//
// The same bytes are served at /fs/ui/v1/ by the accounts Worker online and by `folder-sync serve` on a machine
// (docs/peps/0007 §5.1). Files is rooted above v1, so serve mounts it at /fs/ui/ and a later v2 sits beside it.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed v1
var files embed.FS

// Files is the element's files: v1/folder-sync.js and v1/vendor/diff.js (jsdiff, with its licence).
var Files fs.FS = files
