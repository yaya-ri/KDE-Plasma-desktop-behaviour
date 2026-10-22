#!/usr/bin/env bash
# Installer / pengatur on-off untuk KDE Plasma desktop behaviour.
# Lisensi: GPL-2.0-or-later
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="$HOME/.local/bin"
CLI_NAME="kde-desktop-behaviour"

# nama fitur | jenis | id plugin | deskripsi singkat
FEATURES=(
    "tile-animation|effect|tileanimation|Animasi halus saat jendela di-tile / di-snap (Meta+Panah)"
    "maximize-desktop|script|spacemaximize|Maximize/fullscreen pindah ke desktop baru dengan animasi geser (ala macOS Spaces)"
    "per-monitor-desktops|script|permonitordesktops|Tiap monitor punya desktop aktif sendiri"
)

if [[ -t 1 ]]; then
    B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
    B=""; G=""; Y=""; R=""; N=""
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ---------- akses ke KWin (D-Bus) ----------

QDBUS=""
for candidate in qdbus6 qdbus-qt6 qdbus; do
    if command -v "$candidate" >/dev/null 2>&1; then QDBUS="$candidate"; break; fi
done

kwin_reconfigure() {
    if [[ -n $QDBUS ]]; then "$QDBUS" org.kde.KWin /KWin reconfigure >/dev/null 2>&1
    else busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null 2>&1; fi
}
kwin_load_effect() {
    if [[ -n $QDBUS ]]; then "$QDBUS" org.kde.KWin /Effects org.kde.kwin.Effects.loadEffect "$1" >/dev/null 2>&1
    else busctl --user call org.kde.KWin /Effects org.kde.kwin.Effects loadEffect s "$1" >/dev/null 2>&1; fi
}
kwin_unload_effect() {
    if [[ -n $QDBUS ]]; then "$QDBUS" org.kde.KWin /Effects org.kde.kwin.Effects.unloadEffect "$1" >/dev/null 2>&1
    else busctl --user call org.kde.KWin /Effects org.kde.kwin.Effects unloadEffect s "$1" >/dev/null 2>&1; fi
}
kwin_script_loaded() {
    local out
    if [[ -n $QDBUS ]]; then out=$("$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded "$1" 2>/dev/null)
    else out=$(busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting isScriptLoaded s "$1" 2>/dev/null); fi
    [[ $out == *true* ]]
}
kwin_invoke_shortcut() {
    if [[ -n $QDBUS ]]; then "$QDBUS" org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut "$1" >/dev/null 2>&1
    else busctl --user call org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component invokeShortcut s "$1" >/dev/null 2>&1; fi
}
kwin_running() {
    if [[ -n $QDBUS ]]; then "$QDBUS" org.kde.KWin >/dev/null 2>&1
    else busctl --user status org.kde.KWin >/dev/null 2>&1; fi
}

# ---------- helper fitur ----------

feature_field() { # <fitur> <indeks 0-3>
    local entry
    for entry in "${FEATURES[@]}"; do
        IFS='|' read -r -a f <<<"$entry"
        if [[ ${f[0]} == "$1" ]]; then printf '%s' "${f[$2]}"; return 0; fi
    done
    return 1
}
feature_exists() { feature_field "$1" 0 >/dev/null 2>&1; }
feature_names()  { local e; for e in "${FEATURES[@]}"; do printf '%s\n' "${e%%|*}"; done; }

feature_dir() { # lokasi pemasangan
    local type id; type=$(feature_field "$1" 1); id=$(feature_field "$1" 2)
    if [[ $type == effect ]]; then printf '%s/kwin/effects/%s' "$DATA_HOME" "$id"
    else printf '%s/kwin/scripts/%s' "$DATA_HOME" "$id"; fi
}
feature_src() {
    local type id; type=$(feature_field "$1" 1); id=$(feature_field "$1" 2)
    if [[ $type == effect ]]; then printf '%s/effects/%s' "$REPO_DIR" "$id"
    else printf '%s/scripts/%s' "$REPO_DIR" "$id"; fi
}
feature_installed() { [[ -d "$(feature_dir "$1")" ]]; }
feature_enabled() {
    local id; id=$(feature_field "$1" 2)
    [[ $(kreadconfig6 --file kwinrc --group Plugins --key "${id}Enabled" 2>/dev/null) == true ]]
}

resolve_features() { # argumen -> daftar nama fitur valid (satu per baris)
    if [[ $# -eq 0 || $1 == all ]]; then feature_names; return; fi
    local name
    for name in "$@"; do
        feature_exists "$name" || die "Fitur tidak dikenal: '$name'. Pilihan: $(feature_names | tr '\n' ' ')all"
        printf '%s\n' "$name"
    done
}

check_environment() {
    command -v kwriteconfig6 >/dev/null 2>&1 || die "kwriteconfig6 tidak ditemukan. Skrip ini butuh KDE Plasma 6."
    command -v kreadconfig6 >/dev/null 2>&1 || die "kreadconfig6 tidak ditemukan. Skrip ini butuh KDE Plasma 6."
    if command -v plasmashell >/dev/null 2>&1; then
        local version major
        version=$(plasmashell --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)
        major=${version%%.*}
        if [[ -n $major && $major -lt 6 ]]; then die "Terdeteksi Plasma $version. Skrip ini butuh Plasma 6."; fi
    else
        warn "plasmashell tidak ditemukan, versi Plasma tidak bisa dicek."
    fi
    if ! kwin_running; then
        warn "KWin tidak terdeteksi berjalan di sesi ini. File tetap dipasang, tapi aktifkan fitur dari sesi KDE."
    fi
}

# ---------- perintah ----------

cmd_install() {
    check_environment
    local names name src dest
    names=$(resolve_features "$@") || exit 1
    while IFS= read -r name; do
        src=$(feature_src "$name"); dest=$(feature_dir "$name")
        [[ -d $src ]] || die "Folder sumber tidak ada: $src"
        mkdir -p "$(dirname "$dest")"
        rm -rf "$dest"
        cp -r "$src" "$dest"
        ok "Terpasang: $name  →  $dest"
    done <<<"$names"

    mkdir -p "$BIN_DIR"
    if [[ ${BASH_SOURCE[0]} != "$BIN_DIR/$CLI_NAME" ]]; then
        cp "$REPO_DIR/install.sh" "$BIN_DIR/$CLI_NAME" && chmod +x "$BIN_DIR/$CLI_NAME"
        ok "Perintah pengatur: $BIN_DIR/$CLI_NAME  (on/off tanpa perlu folder repo)"
    fi
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR belum ada di PATH. Login ulang, atau jalankan dengan path lengkap." ;; esac
    info ""
    info "Fitur belum aktif. Aktifkan dengan:  ${B}$CLI_NAME enable <fitur>${N}   (lihat: $CLI_NAME status)"
}

enable_one() {
    local name=$1 type id
    type=$(feature_field "$name" 1); id=$(feature_field "$name" 2)
    feature_installed "$name" || die "'$name' belum dipasang. Jalankan: $0 install"
    kwriteconfig6 --file kwinrc --group Plugins --key "${id}Enabled" true
    kwin_reconfigure
    if [[ $type == effect ]]; then kwin_load_effect "$id"; fi
    ok "Aktif: $name"
}

disable_one() {
    local name=$1 type id
    type=$(feature_field "$name" 1); id=$(feature_field "$name" 2)
    if [[ $name == per-monitor-desktops ]] && kwin_script_loaded "$id"; then
        # kembalikan semua jendela ke perilaku KDE normal sebelum script dimatikan
        kwin_invoke_shortcut PerMonitorDesktopsRestore
        sleep 1
    fi
    kwriteconfig6 --file kwinrc --group Plugins --key "${id}Enabled" false
    if [[ $type == effect ]]; then kwin_unload_effect "$id"; fi
    kwin_reconfigure
    ok "Nonaktif: $name"
}

cmd_enable() {
    check_environment
    [[ $# -gt 0 ]] || die "Sebutkan fitur: $(feature_names | tr '\n' ' ')atau 'all'"
    local names name
    names=$(resolve_features "$@") || exit 1
    while IFS= read -r name; do enable_one "$name"; done <<<"$names"
}
cmd_disable() {
    check_environment
    [[ $# -gt 0 ]] || die "Sebutkan fitur: $(feature_names | tr '\n' ' ')atau 'all'"
    local names name
    names=$(resolve_features "$@") || exit 1
    while IFS= read -r name; do disable_one "$name"; done <<<"$names"
}

cmd_uninstall() {
    check_environment
    local names name dest
    names=$(resolve_features "$@") || exit 1
    while IFS= read -r name; do
        if feature_installed "$name"; then
            disable_one "$name"
            dest=$(feature_dir "$name")
            rm -rf "$dest"
            ok "Dihapus: $name"
        else
            info "Lewati (belum dipasang): $name"
        fi
    done <<<"$names"
    if [[ $# -eq 0 || $1 == all ]]; then
        rm -f "$BIN_DIR/$CLI_NAME" && info "Perintah $CLI_NAME dihapus."
    fi
}

cmd_status() {
    local entry name desc state inst
    printf '%-22s %-10s %-8s %s\n' "FITUR" "TERPASANG" "AKTIF" "KETERANGAN"
    for entry in "${FEATURES[@]}"; do
        IFS='|' read -r name _ _ desc <<<"$entry"
        if feature_installed "$name"; then inst="ya"; else inst="tidak"; fi
        if feature_enabled "$name"; then state="ya"; else state="tidak"; fi
        printf '%-22s %-10s %-8s %s\n' "$name" "$inst" "$state" "$desc"
    done
}

usage() {
    cat <<EOF
${B}KDE Plasma desktop behaviour${N} - installer dan pengatur on/off

Pemakaian:
  $0 install [fitur...|all]     pasang file (belum mengaktifkan)
  $0 enable  <fitur...|all>     aktifkan
  $0 disable <fitur...|all>     nonaktifkan
  $0 status                     lihat status semua fitur
  $0 uninstall [fitur...|all]   nonaktifkan lalu hapus

Fitur:
$(for e in "${FEATURES[@]}"; do IFS='|' read -r n _ _ d <<<"$e"; printf '  %-22s %s\n' "$n" "$d"; done)

Contoh:
  $0 install
  $0 enable tile-animation maximize-desktop
  $0 disable per-monitor-desktops
EOF
}

case "${1:-}" in
    install)   shift; cmd_install "$@" ;;
    enable)    shift; cmd_enable "$@" ;;
    disable)   shift; cmd_disable "$@" ;;
    uninstall) shift; cmd_uninstall "$@" ;;
    status)    cmd_status ;;
    -h|--help|help|"") usage ;;
    *) usage; exit 1 ;;
esac
