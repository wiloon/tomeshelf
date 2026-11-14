#!/usr/bin/env bash
# Runs the Compose example on a locally built image with non-default settings:
# first-run setup, sign-in and an import, then checks the size cap, and that
# the library survives recreating the container. Needs Docker with Compose,
# ko, curl and jq. Run it from the repository root after task build:web.
set -euo pipefail

compose_file=deploy/docker-compose.yml
book=testdata/books/h-g-wells_the-time-machine.epub
port=${TOMESHELF_CHECK_PORT:-19090}
base="http://127.0.0.1:$port"
work=$(mktemp -d)
cookies="$work/cookies"

# Every request goes through a host port mapped only to container port 9090,
# so an ignored TOMESHELF_ADDR leaves the app unreachable. TOMESHELF_DATA stays
# as the example sets it, on the volume and away from the default ./data.
cat >"$work/override.yml" <<EOF
services:
  tomeshelf:
    environment:
      TOMESHELF_ADDR: ":9090"
      TOMESHELF_MAX_BOOK_MB: "1"
    ports: !override
      - "127.0.0.1:$port:9090"
EOF

compose() {
	docker compose -p tomeshelf-check -f "$compose_file" -f "$work/override.yml" "$@"
}

cleanup() {
	compose down -v --remove-orphans >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

fail() {
	echo "check-compose: $*" >&2
	compose logs >&2 || true
	exit 1
}

# request prints the response's status code and leaves its body in $work/body.
request() {
	curl -sS -o "$work/body" -w '%{http_code}' "$@" || true
}

expect_status() {
	local what=$1 want=$2
	shift 2
	local got
	got=$(request "$@")
	[[ "$got" == "$want" ]] || fail "$what: want status $want, got $got: $(cat "$work/body" 2>/dev/null)"
}

wait_ready() {
	for _ in $(seq 60); do
		if [[ "$(request "$base/readyz")" == 200 ]]; then
			return
		fi
		sleep 1
	done
	fail "GET /readyz on $base did not answer 200 within 60 s"
}

compose config --quiet

TOMESHELF_IMAGE=$(KO_DOCKER_REPO=ko.local ko build --bare ./cmd/tomeshelf)
export TOMESHELF_IMAGE

compose down -v --remove-orphans
compose up -d
wait_ready

expect_status "first-run setup" 201 -X POST "$base/api/setup" \
	-H 'Content-Type: application/json' -d '{"username":"admin","password":"check-password"}'
expect_status "sign-in" 204 -c "$cookies" -X POST "$base/api/session" \
	-H 'Content-Type: application/json' -d '{"username":"admin","password":"check-password"}'
expect_status "import" 201 -b "$cookies" -X POST "$base/api/books" \
	-H 'Content-Type: application/epub+zip' --data-binary "@$book"
title=$(jq -r .title "$work/body")
[[ -n "$title" && "$title" != null ]] || fail "the import answered no title: $(cat "$work/body")"

head -c $((2 << 20)) /dev/zero >"$work/over-cap.epub"
expect_status "import one MB over the 1 MB cap" 413 -b "$cookies" -X POST "$base/api/books" \
	-H 'Content-Type: application/epub+zip' --data-binary "@$work/over-cap.epub"

compose up -d --force-recreate
wait_ready

expect_status "library after recreate" 200 -b "$cookies" "$base/api/books"
jq -e --arg title "$title" 'any(.[]; .title == $title)' "$work/body" >/dev/null ||
	fail "the library lost \"$title\" when the container was recreated: $(cat "$work/body")"

echo "check-compose: ok"
