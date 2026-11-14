package library

import "sync"

// shaLocks holds one lock per SHA-256 of an original, in this process
// (ADR-0007, ADR-0008). Its zero value is ready to use.
type shaLocks struct {
	mu sync.Mutex
	m  map[string]*shaLock
}

type shaLock struct {
	sync.Mutex
	users int
}

// lock takes the lock of sum and returns the function that releases it.
func (s *shaLocks) lock(sum string) (unlock func()) {
	s.mu.Lock()
	if s.m == nil {
		s.m = map[string]*shaLock{}
	}
	l := s.m[sum]
	if l == nil {
		l = &shaLock{}
		s.m[sum] = l
	}
	l.users++
	s.mu.Unlock()

	l.Lock()
	return func() {
		l.Unlock()
		s.mu.Lock()
		l.users--
		if l.users == 0 {
			delete(s.m, sum)
		}
		s.mu.Unlock()
	}
}
