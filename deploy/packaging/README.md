# Collector packaging (maintainers)

The files here become the `.deb`/`.rpm` packages and release archives of `otelcol-chopper`. [`.goreleaser.yaml`](../../.goreleaser.yaml) at the repo root assembles them; the user-facing install guide is [docs/deploy/install-the-collector.md](../../docs/deploy/install-the-collector.md).

| File | Installed as |
|---|---|
| `config.yaml` | `/etc/telemetry-chopper/config.yaml`, and `config.yaml` in the archives |
| `../../data-plane/config/rules.example.yaml` | `/etc/telemetry-chopper/rules.yaml`, and `rules.yaml` in the archives |
| `telemetry-chopper.conf` | `/etc/telemetry-chopper/telemetry-chopper.conf` (systemd `EnvironmentFile`) |
| `telemetry-chopper.service` | `/usr/lib/systemd/system/telemetry-chopper.service` |
| `scripts/*.sh` | Package install/remove scripts: create the account, enable/start, stop/disable |
| `README.archive.md` | `README.md` in the archives |

The three `/etc` files are `config|noreplace`: upgrades never overwrite a file the user changed.

## Build locally

Requires `builder` (`make ocb`) and [GoReleaser](https://goreleaser.com/install/) v2.

```bash
goreleaser release --snapshot --clean --skip=sign,sbom
ls dist/
```

To try the `.deb` with systemd, in a container:

```bash
docker run -d --name pkg-test --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw debian:12 \
  bash -c "apt-get update -qq && apt-get install -y -qq systemd curl && exec /lib/systemd/systemd"
docker cp dist/telemetry-chopper_*_arm64.deb pkg-test:/root/tc.deb   # not /tmp: systemd mounts a tmpfs there
docker exec pkg-test dpkg -i /root/tc.deb
docker exec pkg-test systemctl status telemetry-chopper
```

CI runs the same snapshot on every pull request (`collector-packages` in `ci.yaml`) and installs the `.deb` on the runner.

## Release

Pushing a `v*.*.*` tag runs `collector-packages` in [`release.yaml`](../../.github/workflows/release.yaml): govulncheck on the generated collector module, then GoReleaser builds, signs `checksums.txt` with cosign (keyless, the workflow's OIDC identity), generates SBOMs and creates the GitHub Release.

The Homebrew cask is published only when the `HOMEBREW_TAP_TOKEN` Actions secret is set. To enable it:

1. Create the public repository `PRIYAM232/homebrew-tap`.
2. Create a fine-grained token with **Contents: read and write** on that repository only.
3. Add it as the `HOMEBREW_TAP_TOKEN` secret of this repository.
