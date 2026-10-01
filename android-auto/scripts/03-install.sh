#!/usr/bin/env bash
# Installe l'APK sur le téléphone branché en USB. Usage : scripts/03-install.sh [debug|release]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VARIANT="${1:-debug}"
APK="$PROJECT_DIR/dist/carhooks-$VARIANT.apk"
[ -f "$APK" ] || die "pas d'APK : lance d'abord scripts/02-build.sh $VARIANT"

if ! adb devices | awk 'NR>1 && $2=="device"{found=1} END{exit !found}'; then
    warn "Aucun appareil vu par adb."
    echo "APK : $(win_path "$PROJECT_DIR/dist")\carhooks-$VARIANT.apk"
    cat <<'TXT'

WSL n'a pas accès à l'USB par défaut. Deux options :

  a) Utiliser l'adb de Windows (le plus simple) :
     ouvre PowerShell et lance
       adb install -r <le chemin affiché juste au-dessus>

  b) Partager le port USB avec WSL via usbipd-win :
       winget install usbipd
       usbipd list
       usbipd bind   --busid <BUSID>
       usbipd attach --wsl --busid <BUSID>
     puis relancer ce script.

  c) Ou simplement copier l'APK sur le téléphone et l'ouvrir.
TXT
    exit 1
fi

say "Installation de $APK"
adb install -r "$APK"
say "Lancement"
adb shell monkey -p com.bidouille.carhooks -c android.intent.category.LAUNCHER 1 >/dev/null
