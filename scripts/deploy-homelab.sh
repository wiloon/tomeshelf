#!/usr/bin/env bash
set -Eeuo pipefail

source_checkout=$(cd "${1:?tomeshelf checkout required}" && pwd)
config_checkout=${2:?w10n-config checkout required}
sha=${3:?tomeshelf commit SHA required}
tag=main-${sha:0:7}
image_repo=ghcr.io/wiloon/tomeshelf
manifest=infra/homelab/k8s/tomeshelf/deployment.yaml
source_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"
config_url=https://github.com/wiloon/w10n-config
max_delay=${DEPLOY_RETRY_DELAY_MAX:-4}

summary() {
  printf 'Image: %s:%s\n\nOutcome: %s\n\nw10n-config: %s/commit/%s\n' \
    "$image_repo" "$tag" "$1" "$config_url" "$2" >> "$GITHUB_STEP_SUMMARY"
}

fail() {
  summary "failed ($1)" "$inspected_tip"
  printf 'Write-back failed: %s\n' "$1" >&2
  exit 1
}

cd "$config_checkout"
inspected_tip=$(git rev-parse HEAD)
trap 'fail "write-back command failed at line $LINENO"' ERR

# Match this repository's image and preserve the rest of the line.
image_line='^([[:blank:]]*image:[[:blank:]]+ghcr\.io/wiloon/tomeshelf:)([^[:space:]#]+)([[:blank:]]*(#.*)?)$'

for attempt in 1 2 3 4 5; do
  inspected_tip=$(git rev-parse HEAD)
  [[ -f $manifest ]] || fail 'image line missing'
  current=$(sed -nE "s|$image_line|\\2|p" "$manifest")
  [[ -n $current ]] || fail 'image line missing'
  [[ $current != *$'\n'* ]] || fail 'multiple image lines'

  if [[ $current == "$tag" ]]; then
    last_change=$(git log -1 --format=%H "$inspected_tip" -- "$manifest")
    summary 'already selected' "$last_change"
    exit 0
  fi
  if [[ $current == main-* ]]; then
    current_sha=${current#main-}
    [[ $current_sha =~ ^[0-9a-f]{7}$ ]] || fail "unresolvable $current"
    if ! selected=$(git -C "$source_checkout" rev-parse --verify --quiet "$current_sha^{commit}"); then
      git -C "$source_checkout" fetch origin main || fail "unresolvable $current"
      selected=$(git -C "$source_checkout" rev-parse --verify --quiet "$current_sha^{commit}") ||
        fail "unresolvable $current"
    fi
    if git -C "$source_checkout" merge-base --is-ancestor "$sha" "$selected"; then
      last_change=$(git log -1 --format=%H "$inspected_tip" -- "$manifest")
      summary 'skipped as older' "$last_change"
      exit 0
    elif [[ $? != 1 ]]; then
      fail "could not compare $tag with $current"
    fi
  fi

  sed -i -E "s|$image_line|\\1$tag\\3|" "$manifest"
  git add -- "$manifest"
  git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m "chore(tomeshelf): deploy $tag" \
    -m "Commit: $source_url/commit/$sha" \
    -m "Run: $source_url/actions/runs/$GITHUB_RUN_ID"
  if [[ -n ${DEPLOY_BEFORE_PUSH:-} ]]; then
    bash -e -c "$DEPLOY_BEFORE_PUSH"
  fi
  if git push origin HEAD:refs/heads/main; then
    deployed_commit=$(git rev-parse HEAD)
    summary 'deployed' "$deployed_commit"
    exit 0
  fi

  [[ $attempt != 5 ]] || fail 'retries exhausted'
  # Refresh the checkout and reconsider the tag before creating a new commit.
  # inspected_tip still identifies the rejected decision if either command fails.
  git fetch origin refs/heads/main:refs/remotes/origin/main || fail 'fetch failed'
  git reset --hard refs/remotes/origin/main || fail 'fetch failed'
  if (( max_delay > 0 )); then
    sleep "$((1 + RANDOM % max_delay))"
  fi
done
