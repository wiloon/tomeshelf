// Command tomeshelf serves the tomeshelf browser app and its API.
//
// tomeshelf reset-password -data <dir> -user <name> reads a new password for
// the user from stdin and ends the user's sessions.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/wiloon/tomeshelf/internal/library"
	"github.com/wiloon/tomeshelf/internal/password"
	"github.com/wiloon/tomeshelf/internal/server"
	"github.com/wiloon/tomeshelf/internal/store"
	"github.com/wiloon/tomeshelf/web"
)

const dbFile = "tomeshelf.db"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "reset-password" {
		os.Exit(resetPassword(os.Args[2:], os.Stdin, os.Stderr))
	}

	cfg, err := parseConfig(os.Args[1:], os.LookupEnv)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(0)
	}
	if err != nil {
		os.Exit(2)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, logger, nil); err != nil {
		logger.Error("tomeshelf stopped", "err", err)
		os.Exit(1)
	}
}

type config struct {
	addr      string
	dataDir   string
	maxBookMB int64
}

// parseConfig reads the server's flags from args. Each flag's default comes
// from its environment variable, looked up with lookupEnv.
func parseConfig(args []string, lookupEnv func(string) (string, bool)) (config, error) {
	envOr := func(key, fallback string) string {
		if v, ok := lookupEnv(key); ok {
			return v
		}
		return fallback
	}
	flags := flag.NewFlagSet("tomeshelf", flag.ContinueOnError)
	addr := flags.String("addr", envOr("TOMESHELF_ADDR", ":8080"), "address to listen on")
	dataDir := flags.String("data", envOr("TOMESHELF_DATA", "./data"), "data directory")
	maxBookMB := flags.String("max-book-mb", envOr("TOMESHELF_MAX_BOOK_MB", "200"), "largest EPUB to import, in MB")
	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	mb, err := strconv.ParseInt(*maxBookMB, 10, 64)
	if err != nil || mb < 1 || mb > math.MaxInt64>>20 {
		err := fmt.Errorf("-max-book-mb / TOMESHELF_MAX_BOOK_MB = %q: want a whole number of MB, at least 1", *maxBookMB)
		fmt.Fprintln(flags.Output(), err)
		return config{}, err
	}
	return config{addr: *addr, dataDir: *dataDir, maxBookMB: mb}, nil
}

// run opens the database and the library in the data directory and applies
// the migrations, then serves on cfg.addr until ctx is done. listening, if
// not nil, gets the address once the server listens.
func run(ctx context.Context, cfg config, logger *slog.Logger, listening func(addr string)) error {
	st, err := openStore(ctx, cfg.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()
	books, err := library.Open(cfg.dataDir, st)
	if err != nil {
		return err
	}

	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           server.New(web.Build(), logger, st, books, cfg.maxBookMB<<20),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	logger.Info("listening", "addr", ln.Addr().String())
	if listening != nil {
		listening(ln.Addr().String())
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func openStore(ctx context.Context, dataDir string) (*store.Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	return store.Open(ctx, filepath.Join(dataDir, dbFile))
}

// resetPassword runs the reset-password subcommand and returns its exit code.
// The password comes from stdin, not argv, so it stays out of shell history
// and the process list.
func resetPassword(args []string, stdin io.Reader, stderr io.Writer) int {
	flags := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	flags.SetOutput(stderr)
	dataDir := flags.String("data", envOr("TOMESHELF_DATA", "./data"), "data directory")
	user := flags.String("user", "", "username whose password to reset")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *user == "" {
		fmt.Fprintln(stderr, "reset-password: -user is required")
		return 2
	}

	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(stderr, "reset-password: read the password from stdin:", err)
		return 1
	}
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		fmt.Fprintln(stderr, "reset-password: the new password read from stdin is empty")
		return 1
	}

	ctx := context.Background()
	st, err := openStore(ctx, *dataDir)
	if err != nil {
		fmt.Fprintln(stderr, "reset-password:", err)
		return 1
	}
	defer st.Close()
	hash, err := password.Hash(pw)
	if err != nil {
		fmt.Fprintln(stderr, "reset-password:", err)
		return 1
	}
	if err := st.ResetPassword(ctx, *user, hash); err != nil {
		if errors.Is(err, store.ErrUnknownUser) {
			fmt.Fprintf(stderr, "reset-password: no user named %q\n", *user)
		} else {
			fmt.Fprintln(stderr, "reset-password:", err)
		}
		return 1
	}
	fmt.Fprintf(stderr, "reset-password: set a new password for %q and ended its sessions\n", *user)
	return 0
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
