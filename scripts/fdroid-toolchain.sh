#!/usr/bin/env bash
#
# fdroid-toolchain.sh — the edits F-Droid's build applies to node_modules so that
# React Native 0.73 builds on a JDK 21 machine, for CI to apply too.
#
# WHY CI RUNS IT. fdroiddata's `Binaries:` makes F-Droid compare ITS build with
# whispa-mainnet-fdroid.apk, byte for byte. F-Droid's server is Debian trixie
# (JDK 21 only), so its recipe moves AGP to 8.2.2 and Kotlin to 1.9.22 and drops the
# JDK 17 pin. A CI build left on JDK 17 / AGP 8.1.1 / Kotlin 1.8.0 differs in the dex
# files, the Kotlin metadata, the baseline profiles and libconceal.so: 11 of 590
# entries (measured on 0.6.1). So the F-Droid asset is built on JDK 21 with these
# same edits. See CLAUDE.md, "What is still open".
#
# THE COMMANDS BELOW ARE THE SAME LINES AS THE RECIPE'S `prebuild` BLOCK
# (fdroid/com.whispawallet.app.canonical.yml). The recipe keeps its own copy because it
# is pinned to a commit and runs from a checkout that may predate this file;
# `npm run check:fdroid` fails if the two differ by a character. Change both together.
#
# Run from the repository root, after `npm ci`. It edits node_modules in place, so
# run it only after every build that must NOT have the edits (the standard APK).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

rm -rf node_modules/@capacitor-mlkit/barcode-scanning/android
RNGP=node_modules/@react-native/gradle-plugin
sed -i '/jvmToolchain(17)/d;s/allWarningsAsErrors = true/allWarningsAsErrors = false/' $RNGP/build.gradle.kts
sed -i 's/^agp = "8.1.1"/agp = "8.2.2"/;s/^kotlin = "1.8.0"/kotlin = "1.9.22"/' $RNGP/gradle/libs.versions.toml
sed -i 's|project.extensions.getByType(KotlinTopLevelExtension::class.java).jvmToolchain(17)|project.tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile::class.java).configureEach { it.compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }|' $RNGP/src/main/kotlin/com/facebook/react/utils/JdkConfiguratorUtils.kt

# Fail loudly if an edit matched nothing (a React Native bump moved a line): a
# silent no-op would build on the wrong toolchain and fail F-Droid's comparison.
grep -q '^agp = "8.2.2"' $RNGP/gradle/libs.versions.toml || { echo "fdroid-toolchain: AGP pin not found" >&2; exit 1; }
grep -q '^kotlin = "1.9.22"' $RNGP/gradle/libs.versions.toml || { echo "fdroid-toolchain: Kotlin pin not found" >&2; exit 1; }
! grep -q 'jvmToolchain(17)' $RNGP/build.gradle.kts $RNGP/src/main/kotlin/com/facebook/react/utils/JdkConfiguratorUtils.kt || { echo "fdroid-toolchain: a jvmToolchain(17) is still there" >&2; exit 1; }
