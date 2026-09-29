#!/bin/bash

# Jellyfin Interactive Video Plugin Build Script
#
# Builds with the .NET 10 SDK. When run on a machine that actually runs
# Jellyfin, the assemblies of that server are used (JellyfinDir), so the
# plugin always matches its ABI; otherwise the published SDK packages are
# restored instead (see the .csproj).

set -e

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

PLUGIN_DIR="../plugin"
OUT="$HERE/bin/Release/net10.0"

# Locate the running Jellyfin's assemblies, if there is one on this box.
if [ -z "$JELLYFIN_DIR" ] && command -v systemctl >/dev/null 2>&1; then
    ROOT=$(systemctl cat jellyfin 2>/dev/null | sed -n 's|^ExecStart=\(.*\)/bin/jellyfin .*|\1|p' | head -1)
    [ -n "$ROOT" ] && [ -d "$ROOT/lib/jellyfin" ] && JELLYFIN_DIR="$ROOT/lib/jellyfin"
fi
if [ -n "$JELLYFIN_DIR" ]; then
    echo "Using Jellyfin assemblies from: $JELLYFIN_DIR"
else
    echo "No running Jellyfin found; falling back to the Jellyfin SDK packages"
fi

# Prefer a locally installed SDK, else pull one from nix.
DOTNET=dotnet
if ! command -v dotnet >/dev/null 2>&1; then
    if command -v nix >/dev/null 2>&1; then
        DOTNET="nix shell nixpkgs#dotnet-sdk_10 -c dotnet"
    else
        echo "Error: no dotnet SDK and no nix to get one" >&2
        exit 1
    fi
fi

echo "Building Jellyfin Interactive Video Plugin..."
rm -rf bin obj
$DOTNET build --configuration Release -p:JellyfinDir="$JELLYFIN_DIR"

echo "Copying plugin files to $PLUGIN_DIR..."
mkdir -p "$PLUGIN_DIR"
cp "$OUT/Jellyfin.Plugin.InteractiveVideo.dll" "$PLUGIN_DIR/"
cp "$OUT/Jellyfin.Plugin.InteractiveVideo.pdb" "$PLUGIN_DIR/" 2>/dev/null || true

# Jellyfin >= 10.9 reads a flat meta.json next to the assembly.
cat > "$PLUGIN_DIR/meta.json" << EOF
{
  "category": "General",
  "changelog": "Full Bandersnatch branching data and a player that streams the item from Jellyfin.",
  "description": "Interactive video player for Black Mirror: Bandersnatch with choice-based navigation and branching storylines",
  "guid": "42d83eb8-b6b2-4b1b-b3d9-0c2f2b3b5a6c",
  "name": "Interactive Video Player",
  "overview": "Enables interactive video playback with user choices, keyboard shortcuts, and subtitle support. Based on the original BandersnatchInteractive project.",
  "owner": "deathrjj",
  "targetAbi": "12.0.0.0",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.0000000Z)",
  "version": "1.2.0.0",
  "status": "Active",
  "autoUpdate": false,
  "assemblies": []
}
EOF

echo ""
echo "Plugin files in: $PLUGIN_DIR"
ls -la "$PLUGIN_DIR"
echo ""
echo "Install (Linux): copy that folder to /var/lib/jellyfin/plugins/InteractiveVideo_1.2.0.0/"
echo "Then restart Jellyfin and open /InteractiveVideo/Player/{ItemId}"
