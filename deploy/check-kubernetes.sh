#!/usr/bin/env bash
# Validates the Kubernetes example against the Kubernetes schemas and checks
# the single-replica rules of ADR-0008. Needs Go and network access, no cluster.
set -euo pipefail

manifest="$(dirname "$0")/kubernetes.yaml"
yq() { go run github.com/mikefarah/yq/v4@v4.54.3 "$@"; }

fail() {
	echo "check-kubernetes: $*" >&2
	exit 1
}

expect() {
	local what=$1 want=$2 got=$3
	[[ "$got" == "$want" ]] || fail "$what: want $want, got ${got:-nothing}"
}

go run github.com/yannh/kubeconform/cmd/kubeconform@v0.8.0 -strict -summary "$manifest"

deployment='select(.kind == "Deployment")'
container="$deployment | .spec.template.spec.containers[0]"

expect "Deployment count" 1 "$(yq ea '[select(.kind == "Deployment")] | length' "$manifest")"
expect "replicas" 1 "$(yq "$deployment | .spec.replicas" "$manifest")"
expect "strategy.type" Recreate "$(yq "$deployment | .spec.strategy.type" "$manifest")"
expect "fsGroup" 65532 "$(yq "$deployment | .spec.template.spec.securityContext.fsGroup" "$manifest")"

claim=$(yq "$deployment | .spec.template.spec.volumes[] | select(.persistentVolumeClaim) | .persistentVolumeClaim.claimName" "$manifest")
[[ -n "$claim" ]] || fail "the Deployment mounts no PersistentVolumeClaim"
expect "accessModes of claim $claim" ReadWriteOnce \
	"$(yq "select(.kind == \"PersistentVolumeClaim\" and .metadata.name == \"$claim\") | .spec.accessModes | join(\",\")" "$manifest")"

port=$(yq "$container | .ports[0].containerPort" "$manifest")
port_name=$(yq "$container | .ports[0].name" "$manifest")
expect "TOMESHELF_ADDR" ":$port" "$(yq "$container | .env[] | select(.name == \"TOMESHELF_ADDR\") | .value" "$manifest")"

data=$(yq "$container | .env[] | select(.name == \"TOMESHELF_DATA\") | .value" "$manifest")
[[ "$data" == /* ]] || fail "TOMESHELF_DATA: want an absolute path, got ${data:-nothing}"
volume=$(yq "$deployment | .spec.template.spec.volumes[] | select(.persistentVolumeClaim.claimName == \"$claim\") | .name" "$manifest")
expect "mount path of volume $volume" "$data" \
	"$(yq "$container | .volumeMounts[] | select(.name == \"$volume\") | .mountPath" "$manifest")"

for probe in livenessProbe:/healthz readinessProbe:/readyz; do
	name=${probe%%:*}
	expect "$name path" "${probe#*:}" "$(yq "$container | .$name.httpGet.path" "$manifest")"
	probe_port=$(yq "$container | .$name.httpGet.port" "$manifest")
	[[ "$probe_port" == "$port" || "$probe_port" == "$port_name" ]] ||
		fail "$name port: want $port or $port_name, got ${probe_port:-nothing}"
done

echo "check-kubernetes: ok"
