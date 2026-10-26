// Package service writes the autostart definition for `sync --watch` and the
// command that enables it. folder-sync never registers a service itself:
// enabling one is the user's call (docs/peps/0001 §7).
//
// Linux gets a systemd user unit, Windows a Task Scheduler task started at
// logon (Task Scheduler cannot repeat more often than once a minute, so the
// task runs one long-lived `sync --watch`), macOS a launchd agent.
package service

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"folder-sync/internal/layout"
)

// Spec is what the service runs.
type Spec struct {
	GOOS     string
	Exe      string // absolute path of folder-sync
	Folder   string // absolute path of the project folder
	Project  string
	StateKey string // projects/<key>
	User     string // Windows: DOMAIN\user for the logon trigger
	Layout   layout.Layout
}

// File is a written service definition plus the commands that enable and start it.
type File struct {
	Path     string
	Content  []byte
	Commands []string
}

// Write creates the directory the file lives in, then the file.
func (f File) Write() error {
	if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f.Path, f.Content, 0o644)
}

// Generate renders the service file for spec.GOOS.
func Generate(spec Spec) (File, error) {
	switch spec.GOOS {
	case "linux":
		return systemd(spec), nil
	case "windows":
		return taskScheduler(spec), nil
	case "darwin":
		return launchd(spec), nil
	default:
		return File{}, fmt.Errorf("no service definition for %s; run `folder-sync sync --watch` from your own init system", spec.GOOS)
	}
}

// systemdQuote quotes one ExecStart argument (systemd.service "Command lines").
func systemdQuote(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\"'\\$%;") {
		return arg
	}
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `$$`, `%`, `%%`)
	return `"` + replacer.Replace(arg) + `"`
}

func systemd(spec Spec) File {
	name := "folder-sync-" + spec.StateKey + ".service"
	path := layout.Join(spec.GOOS, spec.Layout.Service, name)
	exec := strings.Join([]string{systemdQuote(spec.Exe), "sync", "--watch", "--dir", systemdQuote(spec.Folder)}, " ")
	unit := fmt.Sprintf(`# Written by folder-sync sync --install-service. Enable it yourself:
#   systemctl --user enable --now %s
[Unit]
Description=folder-sync %s (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%s
ExecStart=%s
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`, path, spec.Project, spec.Folder, strings.ReplaceAll(spec.Folder, "%", "%%"), exec)
	return File{Path: path, Content: []byte(unit), Commands: []string{
		"systemctl --user enable --now " + path,
		"loginctl enable-linger $USER   # optional: keep it running while you are logged out",
	}}
}

func xmlEscape(s string) string {
	var b bytes.Buffer
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		case '\'':
			b.WriteString("&apos;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// TaskName is the Task Scheduler name for a project.
func TaskName(spec Spec) string { return `folder-sync\` + spec.StateKey }

func taskScheduler(spec Spec) File {
	path := layout.Join(spec.GOOS, spec.Layout.Service, "folder-sync-"+spec.StateKey+".xml")
	args := `sync --watch --dir "` + spec.Folder + `"`
	userID := ""
	if spec.User != "" {
		userID = "\n      <UserId>" + xmlEscape(spec.User) + "</UserId>"
	}
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<!-- Written by folder-sync (sync, install-service). Register it yourself with the commands it printed. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>folder-sync %s (%s): sync --watch, started at logon</Description>
    <URI>\%s</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>%s
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">%s
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%s</Command>
      <Arguments>%s</Arguments>
      <WorkingDirectory>%s</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`, xmlEscape(spec.Project), xmlEscape(spec.Folder), xmlEscape(TaskName(spec)), userID, userID,
		xmlEscape(spec.Exe), xmlEscape(args), xmlEscape(spec.Folder))
	body = strings.ReplaceAll(body, "\n", "\r\n")
	return File{Path: path, Content: utf16LE(body), Commands: []string{
		`schtasks /Create /TN "` + TaskName(spec) + `" /XML "` + path + `"`,
		`schtasks /Run /TN "` + TaskName(spec) + `"`,
	}}
}

// utf16LE encodes text as UTF-16 little endian with a BOM, the encoding schtasks /XML expects.
func utf16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 2+2*len(units))
	out[0], out[1] = 0xFF, 0xFE
	for i, unit := range units {
		binary.LittleEndian.PutUint16(out[2+2*i:], unit)
	}
	return out
}

func launchd(spec Spec) File {
	label := "dev.folder-sync." + spec.StateKey
	// WHY: launchd loads ~/Library/LaunchAgents at login and nowhere else. A plist kept under
	// ~/.folder-sync/service would be bootstrapped now and silently gone after a reboot.
	path := layout.Join(spec.GOOS, spec.Layout.Home, "Library", "LaunchAgents", label+".plist")
	logPath := layout.Join(spec.GOOS, spec.Layout.Logs, spec.StateKey+".launchd.log")
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by folder-sync (sync, install-service). Load it yourself with the command it printed. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>sync</string>
    <string>--watch</string>
    <string>--dir</string>
    <string>%s</string>
  </array>
  <key>WorkingDirectory</key>
  <string>%s</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, xmlEscape(label), xmlEscape(spec.Exe), xmlEscape(spec.Folder), xmlEscape(spec.Folder), xmlEscape(logPath), xmlEscape(logPath))
	return File{Path: path, Content: []byte(plist), Commands: []string{
		"launchctl bootstrap gui/$(id -u) " + path,
	}}
}
