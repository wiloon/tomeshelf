package scripts

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const manifestPath = "infra/homelab/k8s/tomeshelf/deployment.yaml"

func manifest(tag string) string {
	image := ""
	if tag != "" {
		image = "        image: ghcr.io/wiloon/tomeshelf:" + tag + "\n"
	}
	return "spec:\n  template:\n    spec:\n      containers:\n      - name: tomeshelf\n" +
		image + "        imagePullPolicy: IfNotPresent\n"
}

type deploymentFixture struct {
	t                                       *testing.T
	source, config, remote, writer, summary string
	older, newer                            string
}

func newDeploymentFixture(t *testing.T) *deploymentFixture {
	t.Helper()
	root := t.TempDir()
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_AUTHOR_NAME", "Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.invalid")
	f := &deploymentFixture{
		t: t, source: filepath.Join(root, "source"), config: filepath.Join(root, "config"),
		remote: filepath.Join(root, "remote.git"), writer: filepath.Join(root, "writer"),
		summary: filepath.Join(root, "summary.md"),
	}
	f.git(root, "init", "-b", "main", f.source)
	f.git(f.source, "commit", "--allow-empty", "-m", "older source")
	f.older = f.git(f.source, "rev-parse", "HEAD")
	f.git(f.source, "commit", "--allow-empty", "-m", "newer source")
	f.newer = f.git(f.source, "rev-parse", "HEAD")
	f.git(root, "init", "--bare", "-b", "main", f.remote)
	f.git(root, "clone", f.remote, f.writer)
	return f
}

func (f *deploymentFixture) git(dir string, args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSuffix(string(out), "\n")
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f *deploymentFixture) start(contents string, unrelated bool) {
	f.t.Helper()
	write(f.t, filepath.Join(f.writer, manifestPath), contents)
	f.git(f.writer, "add", manifestPath)
	f.git(f.writer, "commit", "-m", "initial manifest")
	if unrelated {
		write(f.t, filepath.Join(f.writer, "unrelated.txt"), "unrelated\n")
		f.git(f.writer, "add", "unrelated.txt")
		f.git(f.writer, "commit", "-m", "unrelated tip")
	}
	f.git(f.writer, "push", "origin", "main")
	f.git(filepath.Dir(f.config), "clone", f.remote, f.config)
}

func (f *deploymentFixture) run(sha, beforePush, wantOutcome, wantManifest string, wantSubjects []string, summaryOffset int) {
	f.t.Helper()
	before := strings.Split(f.git(f.remote, "rev-list", "main"), "\n")
	write(f.t, f.summary, "")
	// Record the script as an input to Go's test cache before invoking Bash.
	if _, err := os.Stat("deploy-homelab.sh"); err != nil {
		f.t.Fatal(err)
	}
	cmd := exec.Command("bash", "deploy-homelab.sh", f.source, f.config, sha)
	cmd.Env = append(os.Environ(),
		"GITHUB_STEP_SUMMARY="+f.summary, "GITHUB_SERVER_URL=https://github.com",
		"GITHUB_REPOSITORY=wiloon/tomeshelf", "GITHUB_RUN_ID=121",
		"DEPLOY_RETRY_DELAY_MAX=0", "DEPLOY_BEFORE_PUSH="+beforePush,
		"TEST_WRITER="+f.writer, "TEST_REMOTE="+f.remote)
	out, err := cmd.CombinedOutput()
	f.t.Logf("write-back output:\n%s", out)
	wantFailure := strings.HasPrefix(wantOutcome, "failed")
	if (err != nil) != wantFailure {
		f.t.Errorf("exit error = %v, want failure %t", err, wantFailure)
	}
	log := strings.Split(f.git(f.remote, "rev-list", "main"), "\n")
	if len(log) != len(before)+len(wantSubjects) || !reflect.DeepEqual(log[len(wantSubjects):], before) {
		f.t.Errorf("remote commit history = %v, want %d new commits above %v", log, len(wantSubjects), before)
	} else {
		for i, subject := range wantSubjects {
			if got := f.git(f.remote, "show", "-s", "--format=%s", log[i]); got != subject {
				f.t.Errorf("commit %d subject = %q, want %q", i, got, subject)
			}
			if strings.HasPrefix(subject, "chore(tomeshelf): deploy ") {
				body := f.git(f.remote, "show", "-s", "--format=%b", log[i])
				for _, link := range []string{
					"https://github.com/wiloon/tomeshelf/commit/" + sha,
					"https://github.com/wiloon/tomeshelf/actions/runs/121",
				} {
					if !strings.Contains(body, link) {
						f.t.Errorf("commit body %q lacks %s", body, link)
					}
				}
			}
		}
	}
	if got := f.git(f.remote, "show", "main:"+manifestPath) + "\n"; got != wantManifest {
		f.t.Errorf("remote manifest = %q, want %q", got, wantManifest)
	}
	summary, err := os.ReadFile(f.summary)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, line := range []string{
		"Image: ghcr.io/wiloon/tomeshelf:main-" + sha[:7],
		"Outcome: " + wantOutcome,
	} {
		if !strings.Contains(string(summary), line+"\n") {
			f.t.Errorf("summary %q lacks %q", summary, line)
		}
	}
	if summaryOffset >= len(log) {
		f.t.Fatalf("missing remote commit at offset %d for summary", summaryOffset)
	}
	wantURL := "https://github.com/wiloon/w10n-config/commit/" + log[summaryOffset]
	if !strings.Contains(string(summary), wantURL+"\n") {
		f.t.Errorf("summary %q lacks inspected config commit URL %s", summary, wantURL)
	}
}

func TestDeployHomelab(t *testing.T) {
	t.Run("replaces release tag", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("v0.3.0"), false)
		tag := "main-" + f.newer[:7]
		f.run(f.newer, "", "deployed", manifest(tag), []string{"chore(tomeshelf): deploy " + tag}, 0)
	})
	t.Run("replaces older tag", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("main-"+f.older[:7]), false)
		tag := "main-" + f.newer[:7]
		f.run(f.newer, "", "deployed", manifest(tag), []string{"chore(tomeshelf): deploy " + tag}, 0)
	})
	t.Run("rejects missing image line", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest(""), true)
		f.run(f.newer, "", "failed (image line missing)", manifest(""), nil, 0)
	})
	t.Run("already selected links last manifest change", func(t *testing.T) {
		f := newDeploymentFixture(t)
		current := manifest("main-" + f.newer[:7])
		f.start(current, true)
		f.run(f.newer, "", "already selected", current, nil, 1)
	})
	t.Run("skips older run", func(t *testing.T) {
		f := newDeploymentFixture(t)
		current := manifest("main-" + f.newer[:7])
		f.start(current, true)
		f.run(f.older, "", "skipped as older", current, nil, 1)
	})
	t.Run("rejects unresolvable tag", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.git(f.source, "remote", "add", "origin", ".")
		current := manifest("main-0000000")
		f.start(current, true)
		f.run(f.newer, "", "failed (unresolvable main-0000000)", current, nil, 0)
	})
	t.Run("fetches newer source commit before skipping", func(t *testing.T) {
		f := newDeploymentFixture(t)
		stale := filepath.Join(filepath.Dir(f.source), "stale-source")
		f.git(filepath.Dir(f.source), "clone", f.source, stale)
		f.git(f.source, "commit", "--allow-empty", "-m", "source advanced after checkout")
		latest := f.git(f.source, "rev-parse", "HEAD")
		current := manifest("main-" + latest[:7])
		f.start(current, false)
		f.source = stale
		f.run(f.newer, "", "skipped as older", current, nil, 0)
	})
}

// The competing writer uses the same bare remote as the script under test.
const advance = `
git -C "$TEST_WRITER" commit --allow-empty -m 'competing commit'
git -C "$TEST_WRITER" push origin main
`

func changeManifest(contents string) string {
	return fmt.Sprintf(`
printf '%%s' '%s' > "$TEST_WRITER/%s"
git -C "$TEST_WRITER" add '%s'
`, contents, manifestPath, manifestPath)
}

func TestDeployHomelabRetry(t *testing.T) {
	t.Run("preserves competing manifest edit", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("v0.3.0"), false)
		edit := "        # Keep this edit.\n"
		hook := `if test ! -f .git/competed
then
  touch .git/competed
` + changeManifest(manifest("v0.3.0")+edit) + advance + "\nfi"
		tag := "main-" + f.newer[:7]
		f.run(f.newer, hook, "deployed", manifest(tag)+edit,
			[]string{"chore(tomeshelf): deploy " + tag, "competing commit"}, 0)
	})
	t.Run("skips competing newer tag", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("v0.3.0"), false)
		current := manifest("main-" + f.newer[:7])
		f.run(f.older, changeManifest(current)+advance, "skipped as older", current, []string{"competing commit"}, 0)
	})
	t.Run("exhausts five attempts", func(t *testing.T) {
		f := newDeploymentFixture(t)
		current := manifest("v0.3.0")
		f.start(current, false)
		f.run(f.newer, advance, "failed (retries exhausted)", current,
			[]string{"competing commit", "competing commit", "competing commit", "competing commit", "competing commit"}, 1)
	})
	t.Run("stops after fetch failure", func(t *testing.T) {
		f := newDeploymentFixture(t)
		current := manifest("v0.3.0")
		f.start(current, false)
		hook := advance + `
git config remote.origin.url "$TEST_REMOTE.missing"
git config remote.origin.pushurl "$TEST_REMOTE"
`
		f.run(f.newer, hook, "failed (fetch failed)", current, []string{"competing commit"}, 1)
	})
	t.Run("stops after reset failure and links inspected tip", func(t *testing.T) {
		f := newDeploymentFixture(t)
		current := manifest("v0.3.0")
		f.start(current, false)
		f.run(f.newer, advance+"touch .git/index.lock", "failed (fetch failed)", current, []string{"competing commit"}, 1)
		if got, want := f.git(f.config, "rev-parse", "origin/main"), f.git(f.remote, "rev-parse", "main"); got != want {
			t.Errorf("remote-tracking ref = %s after fetch, want %s", got, want)
		}
	})
}

func TestDeployHomelabRunOrder(t *testing.T) {
	t.Run("newer then older", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("v0.3.0"), false)
		tag := "main-" + f.newer[:7]
		f.run(f.newer, "", "deployed", manifest(tag), []string{"chore(tomeshelf): deploy " + tag}, 0)
		f.run(f.older, "", "skipped as older", manifest(tag), nil, 0)
	})
	t.Run("older then newer", func(t *testing.T) {
		f := newDeploymentFixture(t)
		f.start(manifest("v0.3.0"), false)
		for _, sha := range []string{f.older, f.newer} {
			tag := "main-" + sha[:7]
			f.run(sha, "", "deployed", manifest(tag), []string{"chore(tomeshelf): deploy " + tag}, 0)
		}
	})
}
