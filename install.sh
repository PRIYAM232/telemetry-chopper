#!/bin/sh
# Telemetry Chopper collector installer.
#
#   curl -fsSL https://telemetrychopper.com/install.sh | sh
#
# Installs otelcol-chopper from a GitHub release:
#   - Debian, Ubuntu and derivatives: the .deb package (systemd service)
#   - RHEL, Fedora, Amazon Linux, Rocky, Alma, openSUSE: the .rpm package
#   - macOS and other Linux systems: the binary from the release archive,
#     plus a starter config.yaml and rules.yaml
#
# Every download is checked against the release's checksums.txt. If cosign
# is installed, checksums.txt's Sigstore signature is verified too.
#
# Options (pass after `sh -s --`, e.g. `curl ... | sh -s -- --version 0.1.3`):
#   --version VERSION   install this release instead of the latest
#   --archive           install the binary from the archive even where a
#                       .deb or .rpm package would fit
#   --dir DIR           where --archive installs the binary
#                       (default /usr/local/bin, or ~/.local/bin without root)
#   --dry-run           print what would be installed, change nothing
#
# The same settings work as environment variables: CHOPPER_VERSION,
# CHOPPER_INSTALL_DIR.
#
# Everything is inside main(), called on the last line, so a download cut
# short can't run half a script.

set -eu

REPO="PRIYAM232/telemetry-chopper"
DOCS="https://github.com/${REPO}/blob/main/docs/deploy/install-the-collector.md"

say() { printf '%s\n' "$*"; }
warn() { printf 'install.sh: %s\n' "$*" >&2; }
die() {
    warn "$*"
    exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'EOF_USAGE'
Telemetry Chopper collector installer

  curl -fsSL https://telemetrychopper.com/install.sh | sh
  curl -fsSL https://telemetrychopper.com/install.sh | sh -s -- [options]

Options:
  --version VERSION   install this release instead of the latest
  --archive           install the binary from the archive even where a
                      .deb or .rpm package would fit
  --dir DIR           where --archive installs the binary
                      (default /usr/local/bin, or ~/.local/bin without root)
  --dry-run           print what would be installed, change nothing
  -h, --help          show this help

Environment: CHOPPER_VERSION, CHOPPER_INSTALL_DIR.
EOF_USAGE
}

# Runs a command as root: directly when already root, otherwise via sudo.
as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif have sudo; then
        sudo "$@"
    else
        die "this step needs root and sudo isn't available: run the installer as root"
    fi
}

download() { # url dest
    if have curl; then
        curl -fsSL --retry 3 -o "$2" "$1"
    elif have wget; then
        wget -q -O "$2" "$1"
    else
        die "curl or wget is required"
    fi
}

# Resolves "latest" to a version number by following GitHub's
# /releases/latest redirect, which needs no API token and has no rate limit.
latest_version() {
    if have curl; then
        url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
    else
        # -S --spider works in both GNU and busybox wget (Alpine); GNU
        # appends " [following]" to the Location line.
        url=$(wget -S --spider -O /dev/null "https://github.com/${REPO}/releases/latest" 2>&1 |
            sed -n 's/^ *[Ll]ocation: \([^ ]*\).*/\1/p' | tail -n 1)
    fi
    tag=${url##*/}
    case "$tag" in
        v[0-9]*) printf '%s\n' "${tag#v}" ;;
        *) die "couldn't find the latest release at https://github.com/${REPO}/releases" ;;
    esac
}

sha256_of() {
    if have sha256sum; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif have shasum; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    elif have openssl; then
        openssl dgst -sha256 "$1" | sed 's/.*= //'
    else
        die "sha256sum, shasum or openssl is required to verify the download"
    fi
}

verify() { # file name
    expected=$(awk -v f="$2" '$2 == f { print $1 }' "$tmp/checksums.txt")
    [ -n "$expected" ] || die "$2 isn't listed in checksums.txt for v${version}"
    actual=$(sha256_of "$1")
    [ "$expected" = "$actual" ] || die "checksum mismatch for $2: expected $expected, got $actual"
}

verify_signature() {
    if ! have cosign; then
        say "  checksums.txt signature not checked (install cosign to check it)"
        return
    fi
    download "$base/checksums.txt.sigstore.json" "$tmp/checksums.txt.sigstore.json"
    cosign verify-blob "$tmp/checksums.txt" \
        --bundle "$tmp/checksums.txt.sigstore.json" \
        --certificate-identity "https://github.com/${REPO}/.github/workflows/release.yaml@refs/tags/v${version}" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null 2>&1 ||
        die "checksums.txt's Sigstore signature didn't verify; not installing"
    say "  checksums.txt signature verified (Sigstore)"
}

main() {
    version=${CHOPPER_VERSION:-}
    install_dir=${CHOPPER_INSTALL_DIR:-}
    force_archive=false
    dry_run=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --version)
                [ $# -ge 2 ] || die "--version needs a value"
                version=$2
                shift 2
                ;;
            --version=*)
                version=${1#*=}
                shift
                ;;
            --dir)
                [ $# -ge 2 ] || die "--dir needs a value"
                install_dir=$2
                shift 2
                ;;
            --dir=*)
                install_dir=${1#*=}
                shift
                ;;
            --archive)
                force_archive=true
                shift
                ;;
            --dry-run)
                dry_run=true
                shift
                ;;
            -h | --help)
                usage
                exit 0
                ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
    done
    version=${version#v}

    os=$(uname -s)
    case "$os" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) die "unsupported OS: $os. On Windows, download the zip from https://github.com/${REPO}/releases" ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 rpm_arch=x86_64 ;;
        aarch64 | arm64) arch=arm64 rpm_arch=aarch64 ;;
        *) die "unsupported processor: $(uname -m). Builds exist for x86_64 and arm64" ;;
    esac

    # Pick the install method: a package where the system has a package
    # manager we build for, the archive everywhere else.
    method=archive
    if [ "$os" = linux ] && [ "$force_archive" = false ]; then
        if have apt-get && have dpkg; then
            method=deb
        elif have dnf || have yum || have zypper; then
            method=rpm
        fi
    fi

    if [ -z "$version" ]; then
        version=$(latest_version)
    fi
    base="https://github.com/${REPO}/releases/download/v${version}"

    case "$method" in
        deb) file="telemetry-chopper_${version}_${arch}.deb" ;;
        rpm) file="telemetry-chopper-${version}-1.${rpm_arch}.rpm" ;;
        archive) file="otelcol-chopper_${version}_${os}_${arch}.tar.gz" ;;
    esac

    if [ "$method" = archive ] && [ -z "$install_dir" ]; then
        if [ "$(id -u)" -eq 0 ] || { [ -w /usr/local/bin ] && [ -d /usr/local/bin ]; }; then
            install_dir=/usr/local/bin
        else
            install_dir="$HOME/.local/bin"
        fi
    fi

    say "Installing Telemetry Chopper v${version} (${os}/${arch}, ${method})"
    if [ "$dry_run" = true ]; then
        say "  would download $base/$file"
        case "$method" in
            deb | rpm) say "  would install it with the system package manager and start the telemetry-chopper service" ;;
            archive) say "  would install otelcol-chopper to $install_dir" ;;
        esac
        exit 0
    fi

    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT INT TERM
    # apt reads local packages as its unprivileged _apt user.
    chmod 755 "$tmp"

    download "$base/checksums.txt" "$tmp/checksums.txt" ||
        die "release v${version} not found, or it has no installable files: https://github.com/${REPO}/releases"
    verify_signature
    download "$base/$file" "$tmp/$file" || die "couldn't download $base/$file"
    verify "$tmp/$file" "$file"
    say "  $file checksum verified"

    case "$method" in
        deb)
            # apt-get resolves dependencies, unlike dpkg -i. The path's
            # slash makes it a local file, not a package name.
            as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$tmp/$file"
            ;;
        rpm)
            if have dnf; then
                as_root dnf install -y "$tmp/$file"
            elif have yum; then
                as_root yum install -y "$tmp/$file"
            else
                as_root zypper --non-interactive install --allow-unsigned-rpm "$tmp/$file"
            fi
            ;;
        archive)
            tar -xzf "$tmp/$file" -C "$tmp"
            mkdir -p "$install_dir" 2>/dev/null || as_root mkdir -p "$install_dir"
            if [ -w "$install_dir" ]; then
                install -m 0755 "$tmp/otelcol-chopper" "$install_dir/otelcol-chopper"
            else
                as_root install -m 0755 "$tmp/otelcol-chopper" "$install_dir/otelcol-chopper"
            fi
            # Downloaded with curl, so macOS hasn't quarantined it, but clear
            # the flag in case the archive came through a browser.
            if [ "$os" = darwin ] && have xattr; then
                xattr -d com.apple.quarantine "$install_dir/otelcol-chopper" 2>/dev/null || true
            fi

            # A starter config and rules, never overwriting existing ones.
            conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/telemetry-chopper"
            mkdir -p "$conf_dir"
            for f in config.yaml rules.yaml; do
                [ -e "$conf_dir/$f" ] || cp "$tmp/$f" "$conf_dir/$f"
            done

            say ""
            say "Installed $install_dir/otelcol-chopper"
            case ":$PATH:" in
                *":$install_dir:"*) ;;
                *) say "  $install_dir isn't on your PATH; add it, or run the binary by its full path" ;;
            esac
            say ""
            say "Start it with the starter config and rules in $conf_dir:"
            say "  CHOPPER_RULES_FILE=$conf_dir/rules.yaml otelcol-chopper --config $conf_dir/config.yaml"
            say ""
            say "Docs: $DOCS"
            return
            ;;
    esac

    # The package's own install script prints where everything lives.
    say ""
    if have systemctl && [ -d /run/systemd/system ]; then
        say "Service: $(systemctl is-active telemetry-chopper 2>/dev/null || true)  (systemctl status telemetry-chopper)"
    fi
    say "Edit /etc/telemetry-chopper/rules.yaml to change what's filtered; changes apply within seconds."
    say "Docs: $DOCS"
}

main "$@"
