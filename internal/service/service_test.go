package service

import (
	"encoding/binary"
	"encoding/xml"
	"strings"
	"testing"
	"unicode/utf16"

	"folder-sync/internal/layout"
)

func spec(t *testing.T, goos string, vars map[string]string, exe, folder string) Spec {
	l, err := layout.For(goos, func(k string) string { return vars[k] })
	if err != nil {
		t.Fatal(err)
	}
	return Spec{GOOS: goos, Exe: exe, Folder: folder, Project: "demo", StateKey: "demo-1a2b3c4d", User: `BAM-PC\BAM`, Layout: l}
}

func TestSystemdUnit(t *testing.T) {
	f, err := Generate(spec(t, "linux", map[string]string{"HOME": "/home/bam"}, "/home/bam/.folder-sync/bin/folder-sync", "/home/bam/My Notes"))
	if err != nil {
		t.Fatal(err)
	}
	unit := string(f.Content)
	if f.Path != "/home/bam/.folder-sync/service/folder-sync-demo-1a2b3c4d.service" {
		t.Fatal(f.Path)
	}
	for _, want := range []string{
		`ExecStart=/home/bam/.folder-sync/bin/folder-sync sync --watch --dir "/home/bam/My Notes"`,
		"WorkingDirectory=/home/bam/My Notes", "Restart=on-failure", "WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
	if f.Commands[0] != "systemctl --user enable --now "+f.Path {
		t.Fatal(f.Commands)
	}
}

func decodeUTF16LE(t *testing.T, data []byte) string {
	if len(data) < 2 || data[0] != 0xFF || data[1] != 0xFE {
		t.Fatal("the task XML must start with a UTF-16LE BOM")
	}
	units := make([]uint16, (len(data)-2)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[2+2*i:])
	}
	return string(utf16.Decode(units))
}

func TestTaskSchedulerXML(t *testing.T) {
	vars := map[string]string{"USERPROFILE": `C:\Users\BAM`, "APPDATA": `C:\Users\BAM\AppData\Roaming`}
	f, err := Generate(spec(t, "windows", vars, `C:\Users\BAM\.folder-sync\bin\folder-sync.exe`, `C:\Users\BAM\Documents\Notes & Plans`))
	if err != nil {
		t.Fatal(err)
	}
	if f.Path != `C:\Users\BAM\.folder-sync\service\folder-sync-demo-1a2b3c4d.xml` {
		t.Fatal(f.Path)
	}
	text := decodeUTF16LE(t, f.Content)
	if strings.Contains(strings.ToLower(text), "appdata") {
		t.Fatal("the task must not reference AppData")
	}
	var task struct {
		Triggers struct {
			Logon struct {
				Enabled bool   `xml:"Enabled"`
				UserID  string `xml:"UserId"`
			} `xml:"LogonTrigger"`
		} `xml:"Triggers"`
		Settings struct {
			Multiple string `xml:"MultipleInstancesPolicy"`
			Limit    string `xml:"ExecutionTimeLimit"`
		} `xml:"Settings"`
		Exec struct {
			Command   string `xml:"Command"`
			Arguments string `xml:"Arguments"`
			WorkDir   string `xml:"WorkingDirectory"`
		} `xml:"Actions>Exec"`
	}
	decoder := xml.NewDecoder(strings.NewReader(strings.Replace(text, `encoding="UTF-16"`, `encoding="UTF-8"`, 1)))
	if err := decoder.Decode(&task); err != nil {
		t.Fatalf("not well-formed XML: %v", err)
	}
	if !task.Triggers.Logon.Enabled || task.Triggers.Logon.UserID != `BAM-PC\BAM` {
		t.Errorf("logon trigger: %+v", task.Triggers)
	}
	if task.Exec.Command != `C:\Users\BAM\.folder-sync\bin\folder-sync.exe` ||
		task.Exec.Arguments != `sync --watch --dir "C:\Users\BAM\Documents\Notes & Plans"` ||
		task.Exec.WorkDir != `C:\Users\BAM\Documents\Notes & Plans` {
		t.Errorf("exec: %+v", task.Exec)
	}
	if task.Settings.Multiple != "IgnoreNew" || task.Settings.Limit != "PT0S" {
		t.Errorf("settings: %+v", task.Settings)
	}
	if !strings.Contains(f.Commands[0], `schtasks /Create /TN "folder-sync\demo-1a2b3c4d" /XML "C:\Users\BAM\.folder-sync\service\`) {
		t.Errorf("commands: %q", f.Commands)
	}
}

func TestLaunchdPlist(t *testing.T) {
	f, err := Generate(spec(t, "darwin", map[string]string{"HOME": "/Users/zach"}, "/Users/zach/.folder-sync/bin/folder-sync", "/Users/zach/notes"))
	if err != nil {
		t.Fatal(err)
	}
	var plist struct {
		Dict struct {
			Keys    []string `xml:"key"`
			Strings []string `xml:"string"`
		} `xml:"dict"`
	}
	if err := xml.Unmarshal(f.Content, &plist); err != nil {
		t.Fatalf("not well-formed: %v", err)
	}
	if !strings.Contains(string(f.Content), "<string>--watch</string>") || f.Path != "/Users/zach/.folder-sync/service/dev.folder-sync.demo-1a2b3c4d.plist" {
		t.Fatal(string(f.Content))
	}
	if !strings.HasPrefix(f.Commands[0], "launchctl bootstrap gui/$(id -u) ") {
		t.Fatal(f.Commands)
	}
}

func TestUnknownOSIsAnError(t *testing.T) {
	if _, err := Generate(Spec{GOOS: "plan9"}); err == nil {
		t.Fatal("plan9 has no service definition")
	}
}
