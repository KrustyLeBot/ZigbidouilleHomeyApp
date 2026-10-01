#!/usr/bin/env bash
# Variables communes aux scripts. Sourcé, jamais exécuté directement.

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export GRADLE_HOME="${GRADLE_HOME:-$HOME/gradle-8.9}"

# Versions épinglées : AGP 8.5.2 veut un JDK 17 et le SDK 34.
JDK_PACKAGE="openjdk-17-jdk-headless"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
GRADLE_URL="https://services.gradle.org/distributions/gradle-8.9-bin.zip"
ANDROID_PLATFORM="platforms;android-34"
ANDROID_BUILD_TOOLS="build-tools;34.0.0"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PATH="$GRADLE_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m/!\ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERREUR: %s\033[0m\n' "$*" >&2; exit 1; }

# /mnt/g/Foo/Bar -> G:\Foo\Bar — pour afficher un chemin utilisable côté Windows.
win_path() {
    local p="$1"
    if [[ "$p" == /mnt/?/* ]]; then
        local drive="${p:5:1}"
        printf '%s:\%s\n' "${drive^^}" "$(printf '%s' "${p:7}" | tr '/' '\')"
    else
        printf '%s\n' "$p"
    fi
}
