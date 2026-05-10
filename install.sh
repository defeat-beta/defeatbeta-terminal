#!/usr/bin/env sh
set -eu

REPO="${DEFEATBETA_REPO:-defeat-beta/defeatbeta-terminal}"
VERSION="${DEFEATBETA_VERSION:-latest}"
BIN_NAME="defeatbeta"
INSTALL_BIN_DIR="${DEFEATBETA_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="${DEFEATBETA_INSTALL_DIR:-$HOME/.defeatbeta-terminal}"
VENV_DIR="$INSTALL_DIR/.venv"
PYTHON_DEPS="defeatbeta-api>=0.0.53 matplotlib"

err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '%s\n' "$*"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) err "unsupported OS: $os" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) err "unsupported architecture: $arch" ;;
  esac

  printf '%s-%s' "$os" "$arch"
}

release_url() {
  asset="$1"
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$asset"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$VERSION" "$asset"
  fi
}

main() {
  need_cmd uname
  need_cmd curl
  need_cmd chmod
  need_cmd mkdir
  need_cmd mktemp
  need_cmd uv

  platform="$(detect_platform)"
  asset="$BIN_NAME-$platform"
  url="$(release_url "$asset")"
  tmpdir="$(mktemp -d)"
  tmpbin="$tmpdir/$BIN_NAME"

  cleanup() {
    rm -rf "$tmpdir"
  }
  trap cleanup EXIT INT TERM

  info "Downloading $asset"
  curl -fsSL "$url" -o "$tmpbin" || err "failed to download $url"
  chmod +x "$tmpbin"

  mkdir -p "$INSTALL_BIN_DIR" "$INSTALL_DIR"
  cp "$tmpbin" "$INSTALL_BIN_DIR/$BIN_NAME"

  info "Creating Python environment at $VENV_DIR"
  uv venv "$VENV_DIR" >/dev/null
  uv pip install --upgrade --python "$VENV_DIR/bin/python" $PYTHON_DEPS

  info "Installed $BIN_NAME to $INSTALL_BIN_DIR/$BIN_NAME"
  case ":$PATH:" in
    *":$INSTALL_BIN_DIR:"*) ;;
    *) info "Add $INSTALL_BIN_DIR to PATH to run $BIN_NAME from any shell." ;;
  esac
}

main "$@"
