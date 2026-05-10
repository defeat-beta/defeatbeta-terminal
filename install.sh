#!/usr/bin/env bash
set -euo pipefail

APP="defeatbeta"
REPO="${DEFEATBETA_REPO:-defeat-beta/defeatbeta-terminal}"
REQUESTED_VERSION="${VERSION:-${DEFEATBETA_VERSION:-}}"
INSTALL_ROOT="${DEFEATBETA_INSTALL_DIR:-$HOME/.defeatbeta-terminal}"
INSTALL_BIN_DIR="${DEFEATBETA_BIN_DIR:-$INSTALL_ROOT/bin}"
VENV_DIR="$INSTALL_ROOT/.venv"
PYTHON_DEPS=("defeatbeta-api>=0.0.53" "matplotlib")

MUTED='\033[0;2m'
RED='\033[0;31m'
BRAND='\033[38;2;31;70;245m'
GREEN='\033[0;32m'
NC='\033[0m'

no_modify_path=false
binary_path=""
specific_version=""
download_url=""
install_tmpdir=""

usage() {
  cat <<EOF
Install defeatbeta-terminal.

Usage:
  install.sh [options]

Options:
  -h, --help             Show this help message
  -v, --version VERSION  Install a specific version, for example v0.0.1
  -b, --binary PATH      Install from a local binary instead of downloading
      --no-modify-path   Do not modify shell config files

Examples:
  curl -fsSL https://raw.githubusercontent.com/defeat-beta/defeatbeta-terminal/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/defeat-beta/defeatbeta-terminal/main/install.sh | bash -s -- --version v0.0.1
  ./install.sh --binary ./defeatbeta
EOF
}

print_message() {
  local level="$1"
  local message="$2"
  local color="$NC"

  case "$level" in
    error) color="$RED" ;;
    success) color="$GREEN" ;;
    warning) color="$BRAND" ;;
  esac

  echo -e "${color}${message}${NC}"
}

err() {
  print_message error "Error: $*"
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "missing required command: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      -v|--version)
        [[ -n "${2:-}" ]] || err "--version requires a version argument"
        REQUESTED_VERSION="$2"
        shift 2
        ;;
      -b|--binary)
        [[ -n "${2:-}" ]] || err "--binary requires a path argument"
        binary_path="$2"
        shift 2
        ;;
      --no-modify-path)
        no_modify_path=true
        shift
        ;;
      *)
        print_message warning "Warning: unknown option '$1'"
        shift
        ;;
    esac
  done
}

detect_platform() {
  local raw_os arch rosetta_flag

  raw_os="$(uname -s)"
  arch="$(uname -m)"

  case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*) os="linux" ;;
    *) err "unsupported OS: $raw_os" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) err "unsupported architecture: $arch" ;;
  esac

  if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
    rosetta_flag="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
    if [[ "$rosetta_flag" == "1" ]]; then
      arch="arm64"
    fi
  fi

  platform="$os-$arch"
  case "$platform" in
    darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
    *) err "unsupported platform: $platform" ;;
  esac
}

fetch_latest_version() {
  need_cmd sed

  specific_version="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p'
  )"

  [[ -n "$specific_version" ]] || err "failed to fetch latest version from GitHub"
}

resolve_release_url() {
  local asset="$1"

  if [[ -z "$REQUESTED_VERSION" || "$REQUESTED_VERSION" == "latest" ]]; then
    fetch_latest_version
    download_url="https://github.com/$REPO/releases/latest/download/$asset"
  else
    specific_version="$REQUESTED_VERSION"
    [[ "$specific_version" == v* ]] || specific_version="v$specific_version"
    download_url="https://github.com/$REPO/releases/download/$specific_version/$asset"
  fi
}

cleanup() {
  if [[ -n "${install_tmpdir:-}" ]]; then
    rm -rf "$install_tmpdir"
  fi
}

install_binary_from_download() {
  need_cmd curl
  need_cmd chmod
  need_cmd mktemp

  local asset tmpbin

  detect_platform
  asset="$APP-$platform"
  resolve_release_url "$asset"
  install_tmpdir="$(mktemp -d)"
  tmpbin="$install_tmpdir/$APP"
  trap cleanup EXIT INT TERM

  print_message success ""
  print_message success "Installing defeatbeta-terminal ${MUTED}version:${NC} $specific_version"
  print_message success "${MUTED}Platform:${NC} $platform"
  print_message success "${MUTED}Binary:${NC} $INSTALL_BIN_DIR/$APP"

  curl -# -fL "$download_url" -o "$tmpbin" || err "failed to download $download_url"
  chmod 755 "$tmpbin"
  mkdir -p "$INSTALL_BIN_DIR"
  mv "$tmpbin" "$INSTALL_BIN_DIR/$APP"
}

install_binary_from_local_path() {
  [[ -f "$binary_path" ]] || err "binary not found at $binary_path"

  specific_version="local"
  print_message success ""
  print_message success "Installing defeatbeta-terminal ${MUTED}from:${NC} $binary_path"
  print_message success "${MUTED}Binary:${NC} $INSTALL_BIN_DIR/$APP"

  mkdir -p "$INSTALL_BIN_DIR"
  cp "$binary_path" "$INSTALL_BIN_DIR/$APP"
  chmod 755 "$INSTALL_BIN_DIR/$APP"
}

install_python_deps() {
  need_cmd uv

  print_message success ""
  print_message success "Preparing Python environment ${MUTED}at:${NC} $VENV_DIR"
  mkdir -p "$INSTALL_ROOT"

  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    uv venv "$VENV_DIR"
  else
    print_message success "${MUTED}Using existing virtual environment${NC}"
  fi

  uv pip install --upgrade --python "$VENV_DIR/bin/python" "${PYTHON_DEPS[@]}"
}

add_to_path() {
  local config_file="$1"
  local command="$2"

  if grep -Fxq "$command" "$config_file"; then
    print_message success "${MUTED}PATH already configured in${NC} $config_file"
  elif [[ -w "$config_file" ]]; then
    {
      echo ""
      echo "# defeatbeta-terminal"
      echo "$command"
    } >> "$config_file"
    print_message success "${MUTED}Added defeatbeta to PATH in${NC} $config_file"
  else
    print_message warning "Could not write $config_file. Add this manually:"
    print_message success "  $command"
  fi
}

configure_path() {
  local current_shell config_files config_file path_command

  if [[ "$no_modify_path" == "true" ]]; then
    return
  fi

  if [[ ":$PATH:" == *":$INSTALL_BIN_DIR:"* ]]; then
    return
  fi

  current_shell="$(basename "${SHELL:-sh}")"
  XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

  case "$current_shell" in
    fish)
      config_files="$HOME/.config/fish/config.fish"
      path_command="fish_add_path $INSTALL_BIN_DIR"
      ;;
    zsh)
      config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
      path_command="export PATH=\"$INSTALL_BIN_DIR:\$PATH\""
      ;;
    bash)
      config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
      path_command="export PATH=\"$INSTALL_BIN_DIR:\$PATH\""
      ;;
    *)
      config_files="$HOME/.profile"
      path_command="export PATH=\"$INSTALL_BIN_DIR:\$PATH\""
      ;;
  esac

  config_file=""
  for file in $config_files; do
    if [[ -f "$file" ]]; then
      config_file="$file"
      break
    fi
  done

  if [[ -n "$config_file" ]]; then
    add_to_path "$config_file" "$path_command"
  else
    print_message warning "No shell config file found. Add this manually:"
    print_message success "  $path_command"
  fi

  if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "${GITHUB_PATH:-}" ]]; then
    echo "$INSTALL_BIN_DIR" >> "$GITHUB_PATH"
    print_message success "${MUTED}Added $INSTALL_BIN_DIR to \$GITHUB_PATH${NC}"
  fi
}

print_success() {
  echo ""
  echo -e "${BRAND} ____        __           _     ____       _        ${NC}"
  echo -e "${BRAND}|  _ \\  ___ / _| ___  __ _| |_  | __ )  ___| |_ __ _ ${NC}"
  echo -e "${BRAND}| | | |/ _ \\ |_ / _ \\/ _\` | __| |  _ \\ / _ \\ __/ _\` |${NC}"
  echo -e "${BRAND}| |_| |  __/  _|  __/ (_| | |_  | |_) |  __/ || (_| |${NC}"
  echo -e "${BRAND}|____/ \\___|_|  \\___|\\__,_|\\__| |____/ \\___|\\__\\__,_|${NC}"
  echo -e "${MUTED}Financial terminal for public market data${NC}"
  echo ""
  print_message success "defeatbeta-terminal installed."
  echo ""
  echo -e "Run:"
  echo -e "  ${BRAND}$APP${NC}"

  if [[ ":$PATH:" != *":$INSTALL_BIN_DIR:"* ]]; then
    echo ""
    echo -e "${MUTED}For this shell session, run:${NC}"
    echo -e "  export PATH=\"$INSTALL_BIN_DIR:\$PATH\""
  fi
  echo ""
}

main() {
  parse_args "$@"
  need_cmd uname
  need_cmd mkdir
  need_cmd cp

  if [[ -n "$binary_path" ]]; then
    install_binary_from_local_path
  else
    install_binary_from_download
  fi

  install_python_deps
  configure_path
  print_success
}

main "$@"
