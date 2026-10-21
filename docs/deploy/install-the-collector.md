# Install the collector

`otelcol-chopper`, the Telemetry Chopper collector, ships as a package for Debian, Ubuntu, RHEL, Fedora and other Linux distributions, as an archive for Linux, macOS and Windows, and through Homebrew on macOS. Installed on its own, it filters telemetry with rules from a local file. You don't need the control plane; see [Run without the control plane](../rules/rules-file.md).

## Install with one command

On Linux or macOS:

```bash
curl -fsSL https://telemetrychopper.com/install.sh | sh
```

The script installs the latest release the way that fits your system:

- **Debian, Ubuntu:** the `.deb` package, which sets up and starts the `telemetry-chopper` service.
- **RHEL, Fedora, Amazon Linux, Rocky, Alma, openSUSE:** the `.rpm` package, which does the same.
- **macOS and other Linux systems:** the `otelcol-chopper` binary in `/usr/local/bin` (or `~/.local/bin` if you aren't root), with a starter `config.yaml` and `rules.yaml` in `~/.config/telemetry-chopper`.

It checks every download against the release's `checksums.txt` before installing anything, and also checks that file's Sigstore signature if [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/) is installed. Installing a package asks for your password through `sudo`.

To see what it would do without changing anything, or to pick a version:

```bash
curl -fsSL https://telemetrychopper.com/install.sh | sh -s -- --dry-run
curl -fsSL https://telemetrychopper.com/install.sh | sh -s -- --version 0.1.3
```

Run it with `--help` for every option. The script is [`install.sh`](../../install.sh) in the repository; read it first if you prefer, or follow the manual steps below.

## Install manually

Every release is on the [GitHub releases page](https://github.com/PRIYAM232/telemetry-chopper/releases). The commands below use `VERSION` for the release you want, without the leading `v`:

```bash
VERSION=0.1.3
```

| Method | Platforms | Runs as a service | Rules file |
|---|---|---|---|
| [.deb package](#install-on-debian-or-ubuntu) | Debian, Ubuntu (amd64, arm64) | ✓ systemd | `/etc/telemetry-chopper/rules.yaml` |
| [.rpm package](#install-on-rhel-fedora-or-amazon-linux) | RHEL, Fedora, Amazon Linux, Rocky, Alma (x86_64, aarch64) | ✓ systemd | `/etc/telemetry-chopper/rules.yaml` |
| [Archive](#run-from-an-archive) | Linux, macOS (amd64, arm64), Windows (amd64) | — | `rules.yaml` next to the binary |
| [Homebrew](#install-with-homebrew) | macOS | — | Any path you choose |

For containers and Kubernetes, use the `otelcol-chopper` image or the [Helm chart](../../deploy/helm/README.md) instead.

### Install on Debian or Ubuntu

```bash
ARCH=$(dpkg --print-architecture)   # amd64 or arm64
curl -fsSLO "https://github.com/PRIYAM232/telemetry-chopper/releases/download/v${VERSION}/telemetry-chopper_${VERSION}_${ARCH}.deb"
sudo dpkg -i "telemetry-chopper_${VERSION}_${ARCH}.deb"
```

### Install on RHEL, Fedora or Amazon Linux

```bash
ARCH=$(uname -m)   # x86_64 or aarch64
sudo dnf install -y "https://github.com/PRIYAM232/telemetry-chopper/releases/download/v${VERSION}/telemetry-chopper-${VERSION}-1.${ARCH}.rpm"
```

On systems with `yum` instead of `dnf`, use `sudo yum install -y` with the same URL.

### Run from an archive

Download and extract the archive for your platform: `linux` or `darwin` (macOS), with `amd64` or `arm64`.

```bash
OS=linux ARCH=amd64
curl -fsSL "https://github.com/PRIYAM232/telemetry-chopper/releases/download/v${VERSION}/otelcol-chopper_${VERSION}_${OS}_${ARCH}.tar.gz" | tar xz
CHOPPER_RULES_FILE=./rules.yaml ./otelcol-chopper --config config.yaml
```

On Windows, download `otelcol-chopper_<version>_windows_amd64.zip` from the release page and extract it, then run:

```powershell
$env:CHOPPER_RULES_FILE = ".\rules.yaml"
.\otelcol-chopper.exe --config config.yaml
```

The archive contains the collector, `config.yaml`, the example `rules.yaml`, a short README and the license. The binaries aren't signed for macOS Gatekeeper; if macOS blocks a downloaded binary, run `xattr -d com.apple.quarantine otelcol-chopper` once.

### Install with Homebrew

```bash
brew install --cask priyam232/tap/telemetry-chopper
```

Homebrew installs the `otelcol-chopper` binary only. Download a starting configuration and rules, then run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/PRIYAM232/telemetry-chopper/main/deploy/packaging/config.yaml
curl -fsSL -o rules.yaml https://raw.githubusercontent.com/PRIYAM232/telemetry-chopper/main/data-plane/config/rules.example.yaml
CHOPPER_RULES_FILE=./rules.yaml otelcol-chopper --config config.yaml
```

## After installing a package

The `.deb` and `.rpm` packages, whether installed by the script or manually, set up the same thing. The package creates a `telemetry-chopper` system account, installs the service and starts it. Out of the box, the collector:

- Receives OTLP on port 4317 (gRPC) and 4318 (HTTP), on all interfaces.
- Applies the example rules: drops health-check spans and debug logs, and masks email addresses in log bodies.
- Writes a one-line summary of each batch to the journal, instead of sending telemetry anywhere.

| Path | What it is |
|---|---|
| `/usr/bin/otelcol-chopper` | The collector |
| `/etc/telemetry-chopper/rules.yaml` | Your rules. Edits apply within seconds, without a restart |
| `/etc/telemetry-chopper/config.yaml` | Collector configuration: receivers, exporters, pipelines |
| `/etc/telemetry-chopper/telemetry-chopper.conf` | Environment for the service: command-line options and exporter credentials |
| `/usr/lib/systemd/system/telemetry-chopper.service` | The systemd unit |
| `/var/lib/telemetry-chopper` | Writable state, for exporters' persistent queues |

The files in `/etc/telemetry-chopper` can be read only by root and the service.

## Send telemetry to your backend

1. Open `/etc/telemetry-chopper/config.yaml` and replace the `debug` exporter with your backend, for example:

   ```yaml
   exporters:
     otlp_http:
       endpoint: https://otlp.vendor.example.com
       headers:
         api-key: ${env:VENDOR_API_KEY}
   ```

   List the exporter under each pipeline's `exporters`.

2. Put credentials in `/etc/telemetry-chopper/telemetry-chopper.conf`, for example `VENDOR_API_KEY=…`, rather than in `config.yaml`.

3. Check the configuration and apply it:

   ```bash
   sudo -u telemetry-chopper otelcol-chopper validate --config /etc/telemetry-chopper/config.yaml
   sudo systemctl reload telemetry-chopper
   ```

   Reload re-reads the configuration without stopping the process. If you changed `telemetry-chopper.conf`, use `sudo systemctl restart telemetry-chopper` instead, because systemd reads the environment only at start.

4. Point your applications' OTLP exporters at the machine, on port 4317 or 4318.

To edit rules, change `/etc/telemetry-chopper/rules.yaml` and save it. There's nothing to reload; see [Change rules](../rules/rules-file.md#change-rules).

## Check that it's running

```bash
systemctl status telemetry-chopper
journalctl -u telemetry-chopper -f
curl -s http://127.0.0.1:8888/metrics | grep chopper_filter
```

The journal shows `chopper_filter rules file: ruleset updated` each time the rules change, and the metrics show what each rule matched and dropped.

## Verify a download

Each release has a `checksums.txt` listing the SHA-256 of every file, signed with [Sigstore](https://www.sigstore.dev/) by the release workflow. To check a download:

```bash
curl -fsSLO "https://github.com/PRIYAM232/telemetry-chopper/releases/download/v${VERSION}/checksums.txt"
curl -fsSLO "https://github.com/PRIYAM232/telemetry-chopper/releases/download/v${VERSION}/checksums.txt.sigstore.json"

cosign verify-blob checksums.txt \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity "https://github.com/PRIYAM232/telemetry-chopper/.github/workflows/release.yaml@refs/tags/v${VERSION}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

sha256sum --ignore-missing -c checksums.txt
```

`cosign` reports `Verified OK` when the checksums file was signed by this repository's release workflow for that tag. `sha256sum` then confirms your download matches it. On macOS, use `shasum -a 256 --ignore-missing -c checksums.txt`.

Each archive also has a software bill of materials, `<archive>.sbom.json`, in SPDX format.

## Upgrade

Install the new version's package the same way. Your edited files in `/etc/telemetry-chopper` are kept, and the service restarts on the new version if it was running.

- **Installed with the script:** run it again. It installs the latest release, and leaves your edited config and rules alone.
- **Debian or Ubuntu:** `sudo dpkg -i` the new `.deb`.
- **RPM:** `sudo dnf install` the new `.rpm` URL.
- **Homebrew:** `brew upgrade --cask telemetry-chopper`.

## Uninstall

| Method | Command | What's left |
|---|---|---|
| Debian or Ubuntu | `sudo dpkg -r telemetry-chopper` | `/etc/telemetry-chopper`. Use `sudo dpkg --purge telemetry-chopper` to remove it too |
| RPM | `sudo dnf remove telemetry-chopper` | Edited files, saved as `*.rpmsave` in `/etc/telemetry-chopper` |
| Homebrew | `brew uninstall --cask telemetry-chopper` | Your config and rules files |

Removing the package stops and disables the service. The `telemetry-chopper` account is kept.

## Frequently asked questions

### Can the packaged collector use the control plane instead of a rules file?

Yes. In `/etc/telemetry-chopper/config.yaml`, replace `rules_file` and `rules_file_check_interval` with the control-plane settings (`sync_endpoint`, `stats_endpoint` and `fleet_key`; see the [README](../../README.md#chopper_filter-configuration)), then reload.

### How do I listen only on localhost?

Change the receivers' endpoints in `config.yaml` from `0.0.0.0:4317` and `0.0.0.0:4318` to `127.0.0.1:4317` and `127.0.0.1:4318`, then reload.

### The service won't start after I edited config.yaml

Run `sudo -u telemetry-chopper otelcol-chopper validate --config /etc/telemetry-chopper/config.yaml`. It names the setting or rule that's wrong. `journalctl -u telemetry-chopper -n 50` shows the error from the last start attempt.

### Is there an apt or yum repository?

Not yet. Use the install script or the release page, as shown above. The script fetches the latest release each time you run it, so re-running it upgrades the collector.
