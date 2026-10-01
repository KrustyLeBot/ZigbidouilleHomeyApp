#!/usr/bin/env bash
# Compile l'APK. Usage : scripts/02-build.sh [debug|release] [--in-place] [--clean]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VARIANT="debug"
IN_PLACE=0
CLEAN=0
for arg in "$@"; do
    case "$arg" in
        debug|release) VARIANT="$arg" ;;
        --in-place)    IN_PLACE=1 ;;
        --clean)       CLEAN=1 ;;
        *) die "argument inconnu : $arg" ;;
    esac
done

command -v gradle >/dev/null || die "gradle absent — lance d'abord scripts/01-setup.sh"
[ -d "$ANDROID_SDK_ROOT/platforms" ] || die "SDK absent — lance d'abord scripts/01-setup.sh"

# Gradle sur /mnt/g (le disque Windows vu depuis WSL) est lent et tient mal les verrous
# de fichiers. On compile donc dans le système de fichiers Linux et on rapatrie l'APK.
WORK_DIR="$PROJECT_DIR"
if [ "$IN_PLACE" -eq 0 ] && [[ "$PROJECT_DIR" == /mnt/* ]]; then
    WORK_DIR="$HOME/.carhooks-build"
    say "Projet sur un disque Windows : copie vers $WORK_DIR"
    mkdir -p "$WORK_DIR"
    rsync -a --delete \
        --exclude 'build/' --exclude '.gradle/' --exclude 'dist/' \
        "$PROJECT_DIR/" "$WORK_DIR/"
    printf 'sdk.dir=%s\n' "$ANDROID_SDK_ROOT" > "$WORK_DIR/local.properties"
fi

cd "$WORK_DIR"
[ "$CLEAN" -eq 1 ] && gradle clean

TASK="assemble${VARIANT^}"
say "gradle $TASK"
gradle "$TASK" --console=plain

APK="$WORK_DIR/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
[ -f "$APK" ] || die "APK introuvable : $APK"

mkdir -p "$PROJECT_DIR/dist"
cp "$APK" "$PROJECT_DIR/dist/carhooks-$VARIANT.apk"

say "APK prêt"
ls -lh "$PROJECT_DIR/dist/carhooks-$VARIANT.apk"
echo
echo "Côté Windows : $(win_path "$PROJECT_DIR/dist")\carhooks-$VARIANT.apk"
echo "Copie-le sur le téléphone (câble, Drive, Quick Share…) et installe-le."
echo "Ou branche le téléphone et lance : scripts/03-install.sh"
