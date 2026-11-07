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

The Homebrew cask is pushed to [`PRIYAM232/homebrew-tap`](https://github.com/PRIYAM232/homebrew-tap) only when the `HOMEBREW_TAP_DEPLOY_KEY` Actions secret is set; without it, releases still publish everything else. It uses an SSH deploy key: write access to the tap repository and nothing else, with no expiry, unlike a personal access token. To set it up once:

```bash
gh repo create PRIYAM232/homebrew-tap --public --add-readme --description "Homebrew tap for Telemetry Chopper"
ssh-keygen -t ed25519 -N "" -C "telemetry-chopper release" -f ./homebrew-tap-deploy-key
gh repo deploy-key add ./homebrew-tap-deploy-key.pub -R PRIYAM232/homebrew-tap --allow-write --title "telemetry-chopper release"
gh secret set HOMEBREW_TAP_DEPLOY_KEY -R PRIYAM232/telemetry-chopper < ./homebrew-tap-deploy-key
rm ./homebrew-tap-deploy-key ./homebrew-tap-deploy-key.pub
```

To rotate the key, repeat the last four commands and delete the old key under the tap repository's **Settings → Deploy keys**.

Users then install with `brew install --cask priyam232/tap/telemetry-chopper`, and each release updates the cask with a commit to the tap.
