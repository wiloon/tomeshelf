# tomeshelf

tomeshelf is a self-hosted EPUB reader. You import your EPUB books into a library on your own server and read them in the browser. The book text is rendered into the page itself, with no iframe and no shadow DOM, so word-lookup and other reading extensions work on it.

tomeshelf is one Go binary with the browser app built in. It keeps its data in SQLite and in files in one data directory, and runs as a single replica.

## Install

Images for `linux/amd64` and `linux/arm64` are published to the GitHub Container Registry as `ghcr.io/wiloon/tomeshelf`, tagged with each release version (such as `v1.0.0`) and `latest`. Pin a version tag in production.

### Docker Compose

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) runs tomeshelf with its data on a named volume:

```sh
curl -O https://raw.githubusercontent.com/wiloon/tomeshelf/main/deploy/docker-compose.yml
docker compose up -d
```

Then open <http://localhost:8080>.

The image runs as the non-root user with uid 65532, and a new Docker volume belongs to root. So the example has a one-shot `data-permissions` service that runs `chown 65532:65532` on the volume before tomeshelf starts; tomeshelf itself never runs as root. If you use a bind mount instead of the named volume, give the host directory to uid 65532 yourself (`sudo chown 65532:65532 <dir>`).

Set `TOMESHELF_IMAGE` to run another image, for example a pinned version: `TOMESHELF_IMAGE=ghcr.io/wiloon/tomeshelf:v1.0.0 docker compose up -d`.

### Kubernetes

[`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) is a minimal example: a ReadWriteOnce PersistentVolumeClaim, a Deployment and a Service.

```sh
kubectl apply -f deploy/kubernetes.yaml
```

Keep these settings when you adapt it:

- `replicas: 1` and `strategy: Recreate`. SQLite allows one writer, so the old pod must stop before the new one starts. Never scale tomeshelf beyond one replica.
- `securityContext.fsGroup: 65532`, so the non-root user can write to a fresh volume.
- The probes: `GET /healthz` for liveness and `GET /readyz` for readiness, on the port `TOMESHELF_ADDR` listens on.

The example has no Ingress. Put one, or another reverse proxy with TLS, in front of the Service.

### From source

You need Go, Node.js with pnpm, and [Task](https://taskfile.dev):

```sh
task build
./bin/tomeshelf
```

## Configuration

Each setting is a command-line flag, or the environment variable when the flag is not given:

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `-addr` | `TOMESHELF_ADDR` | `:8080` | Address to listen on, `host:port` or `:port`. |
| `-data` | `TOMESHELF_DATA` | `./data` | Data directory. Both examples set it to `/var/lib/tomeshelf`, on the volume. |
| `-max-book-mb` | `TOMESHELF_MAX_BOOK_MB` | `200` | Largest EPUB that can be imported, in MB: a whole number, at least 1. A larger upload is refused with `413`. |

If you raise the size cap, raise the request body limit of your reverse proxy too (for example `client_max_body_size` in nginx).

Serve tomeshelf over HTTPS. Behind a TLS-terminating reverse proxy, have the proxy send `X-Forwarded-Proto: https`, so the session cookie is marked `Secure`.

## First-run setup

On a fresh data directory tomeshelf has no account. Open it in the browser and it sends you to the setup page, where you choose the admin's username and password. Setup works only once: after that, the page asks you to sign in.

If the password is lost, set a new one from the command line. It reads the new password from standard input and signs the user out everywhere:

```sh
# Docker Compose
docker compose exec -T tomeshelf /ko-app/tomeshelf reset-password -user <name>
# Kubernetes
kubectl exec -i deploy/tomeshelf -- /ko-app/tomeshelf reset-password -user <name>
# The binary
./bin/tomeshelf reset-password -data ./data -user <name>
```

## Back up the data directory

tomeshelf does not back itself up. You must back up its data directory (`TOMESHELF_DATA`). It holds everything:

- `tomeshelf.db`, with `tomeshelf.db-wal` and `tomeshelf.db-shm` beside it while tomeshelf runs: accounts, sessions, the library and reading settings.
- `books/`: the original EPUB files.
- `cache/`: cover thumbnails, which tomeshelf rebuilds when they are missing.

For a consistent copy, stop tomeshelf first (`docker compose stop tomeshelf`, or `kubectl scale deploy/tomeshelf --replicas=0`), copy the whole directory, then start it again. A snapshot of the volume works as well. Replicated storage protects against a failed disk or node, not against deletion or corruption, so it is not a backup.

## For extension authors

Reading pages follow a documented [DOM contract](docs/dom-contract.md): the markup a reading extension can rely on, and what happens when the reader moves to another document. Changing it is a breaking change.

## Fonts

The reading page can use these bundled typefaces (see the Font setting):

- **Literata** — [SIL Open Font License 1.1](web/public/fonts/literata/OFL.txt)
- **Charter** (Bitstream Charter) — [Bitstream Charter license](web/public/fonts/charter/LICENSE.txt); BITSTREAM CHARTER is a registered trademark of Bitstream Inc.
- **Source Serif 4** — [SIL Open Font License 1.1](web/public/fonts/source-serif-4/OFL.txt)

## License

tomeshelf is licensed under the GNU Affero General Public License v3; see [LICENSE](LICENSE).
