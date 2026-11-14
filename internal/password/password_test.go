package password_test

import (
	"strings"
	"testing"

	"github.com/wiloon/tomeshelf/internal/password"
)

func TestHashIsArgon2idPHCWithARandomSalt(t *testing.T) {
	a, err := password.Hash("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	b, err := password.Hash("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(a, "$argon2id$v=19$m=") {
		t.Errorf("hash = %q, want a $argon2id$v=19$m=… PHC string", a)
	}
	if strings.Contains(a, "correct horse") {
		t.Errorf("hash %q contains the password", a)
	}
	if a == b {
		t.Errorf("two hashes of the same password are equal: %q", a)
	}
}

func TestVerify(t *testing.T) {
	hash, err := password.Hash("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	for pw, want := range map[string]bool{"correct horse": true, "wrong horse": false, "": false} {
		if got := password.Verify(pw, hash); got != want {
			t.Errorf("Verify(%q) = %v, want %v", pw, got, want)
		}
	}
	if password.Verify("x", "not a phc string") {
		t.Error("Verify accepted a malformed hash")
	}
}
