#!/bin/sh
# Render the dashboard photos into renders/ without opening Sweet Home 3D.
#
#   sh FloorPlan/tools/render.sh                  # all four
#   sh FloorPlan/tools/render.sh hallway          # just some
#
# Needs a JDK (javac) and Sweet Home 3D 7.5 portable in FloorPlan/SweetHome3D/ for its
# jars (see the README). Override with
# SH3D=<dir holding lib/> and JDK=<dir holding bin/javac>; OUT=<dir> writes elsewhere.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
SH3D=${SH3D:-"$root/SweetHome3D"}
JDK=${JDK:-"/c/Program Files/Java/jdk-11"}
lib="$SH3D/lib"
[ -f "$lib/SweetHome3D.jar" ] || { echo "no $lib/SweetHome3D.jar -- set SH3D" >&2; exit 1; }

# The Windows JDK wants ;-separated Windows paths.
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
cp=""
for j in SweetHome3D.jar sunflow-0.07.3i.jar java3d-1.6/j3dcore.jar java3d-1.6/j3dutils.jar \
         java3d-1.6/vecmath.jar java3d-1.6/jogl-java3d.jar java3d-1.6/gluegen-rt.jar; do
    cp="$cp$(winpath "$lib/$j");"
done
build="$root/build/render-classes"
mkdir -p "$build"
"$JDK/bin/javac" -nowarn -cp "$cp" -d "$(winpath "$build")" "$(winpath "$here/Render.java")"

# The lamp name prefixes each photo switches on. Keys are LIGHTS in rooms.py.
shots=""
for s in ${*:-base kitchen_led kitchen_ceiling hallway bathroom living_tv}; do
    case $s in
        base) shots="$shots|base=" ;;
        kitchen_led) shots="$shots|kitchen_led=Kitchen LED strip" ;;
        kitchen_ceiling) shots="$shots|kitchen_ceiling=Kitchen ceiling light" ;;
        hallway) shots="$shots|hallway=Hallway light" ;;
        bathroom) shots="$shots|bathroom=Bathroom light" ;;
        living_tv) shots="$shots|living_tv=TV screen" ;;
        *) echo "unknown shot $s" >&2; exit 2 ;;
    esac
done
IFS='|'
# shellcheck disable=SC2086
# Not headless: Sweet Home 3D's texture loading touches AWT, and a headless JVM
# throws HeadlessException there. No window opens.
"$JDK/bin/java" -Xmx4g \
    -Djava.library.path="$(winpath "$lib/java3d-1.6/windows/amd64")" \
    -cp "$cp$(winpath "$build")" Render \
    "$(winpath "$root/build/MySweetHome-render.sh3d")" "$(winpath "${OUT:-$root/renders}")" ${shots#|}
