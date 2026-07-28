#!/usr/bin/env bash
# Vendor the Solidity dependencies at exact commits.
#
# Tags can be moved; commit hashes cannot. An audit re-review is priced on
# compiler and dependency churn, so both are pinned by SHA and neither changes
# without a deliberate commit to this file.
set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/contracts/lib"
mkdir -p "$LIB_DIR"

# name|url|sha|tag (tag is documentation only; the SHA is what is checked out)
DEPS=(
  "forge-std|https://github.com/foundry-rs/forge-std|bf647bd6046f2f7da30d0c2bf435e5c76a780c1b|v1.16.2"
  "openzeppelin-contracts|https://github.com/OpenZeppelin/openzeppelin-contracts|5fd1781b1454fd1ef8e722282f86f9293cacf256|v5.6.1"
  "openzeppelin-contracts-upgradeable|https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable|7bf4727aacdbfaa0f36cbd664654d0c9e1dc52bf|v5.6.1"
  "solady|https://github.com/Vectorized/solady|acd959aa4bd04720d640bf4e6a5c71037510cc4b|v0.1.26"
)

for dep in "${DEPS[@]}"; do
  IFS='|' read -r name url sha tag <<< "$dep"
  target="$LIB_DIR/$name"

  if [ -d "$target/.git" ]; then
    current="$(git -C "$target" rev-parse HEAD)"
    if [ "$current" = "$sha" ]; then
      echo "ok       $name $tag ($sha)"
      continue
    fi
    echo "refetch  $name (have $current, want $sha)"
  else
    echo "clone    $name $tag"
    rm -rf "$target"
    git clone --quiet "$url" "$target"
  fi

  git -C "$target" fetch --quiet origin "$sha" 2>/dev/null || git -C "$target" fetch --quiet origin
  git -C "$target" checkout --quiet "$sha"
  echo "ok       $name $tag ($sha)"
done

echo
echo "All Solidity dependencies pinned by commit."
