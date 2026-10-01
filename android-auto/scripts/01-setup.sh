#!/usr/bin/env bash
# Installe la chaîne de build Android dans WSL/Ubuntu. Idempotent : relançable sans risque.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

say "Paquets système (sudo requis)"
sudo apt-get update -qq
sudo apt-get install -y "$JDK_PACKAGE" unzip curl rsync

java -version 2>&1 | head -1 || true

say "Android SDK command-line tools -> $ANDROID_SDK_ROOT"
if [ ! -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
    mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
    tmp="$(mktemp -d)"
    curl -fL# "$CMDLINE_TOOLS_URL" -o "$tmp/cmdline-tools.zip"
    unzip -q "$tmp/cmdline-tools.zip" -d "$tmp"
    rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/latest"
    mv "$tmp/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest"
    rm -rf "$tmp"
else
    echo "déjà présent, on garde"
fi

say "Licences SDK Google"
# pipefail désactivé ici : sdkmanager se termine avant `yes`, qui meurt alors
# d'un SIGPIPE (code 141) et ferait échouer tout le pipeline.
set +o pipefail
yes | sdkmanager --licenses > /dev/null
set -o pipefail

say "Composants SDK : platform-tools, $ANDROID_PLATFORM, $ANDROID_BUILD_TOOLS"
sdkmanager --install "platform-tools" "$ANDROID_PLATFORM" "$ANDROID_BUILD_TOOLS"

say "Gradle -> $GRADLE_HOME"
if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
    tmp="$(mktemp -d)"
    curl -fL# "$GRADLE_URL" -o "$tmp/gradle.zip"
    unzip -q "$tmp/gradle.zip" -d "$HOME"
    rm -rf "$tmp"
else
    echo "déjà présent, on garde"
fi
gradle --version | grep -E '^Gradle' || true

say "local.properties"
printf 'sdk.dir=%s\n' "$ANDROID_SDK_ROOT" > "$PROJECT_DIR/local.properties"

say "Wrapper Gradle (optionnel)"
# Sur NTFS monté dans WSL, gradle ne peut pas poser le bit exécutable sur gradlew.
# Sans importance : les scripts appellent le gradle installé, pas le wrapper.
if ( cd "$PROJECT_DIR" && gradle wrapper --gradle-version 8.9 --quiet ) 2>/dev/null; then
    echo "généré"
else
    warn "wrapper non généré (NTFS refuse le chmod) — sans conséquence, on utilise $(command -v gradle)"
fi

say "Ajout des variables à ~/.bashrc"
marker="# --- carhooks android sdk ---"
if ! grep -qF "$marker" "$HOME/.bashrc" 2>/dev/null; then
    {
        echo ""
        echo "$marker"
        echo "export ANDROID_SDK_ROOT=\"$ANDROID_SDK_ROOT\""
        echo "export ANDROID_HOME=\"\$ANDROID_SDK_ROOT\""
        echo "export PATH=\"$GRADLE_HOME/bin:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$ANDROID_SDK_ROOT/platform-tools:\$PATH\""
    } >> "$HOME/.bashrc"
    echo "ajouté"
else
    echo "déjà là"
fi

say "Terminé. Lance maintenant : scripts/02-build.sh"
