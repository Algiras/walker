#!/usr/bin/env bash
# Builds the site and publishes dist/ to the gh-pages branch of origin (GitHub Pages serves that branch).
set -euo pipefail
cd "$(dirname "$0")/.."

npm test
npm run build

remote="$(git remote get-url origin)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R dist/. "$tmp"
touch "$tmp/.nojekyll"
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c "user.name=$(git config user.name)" -c "user.email=$(git config user.email)" commit -q -m "Deploy $(git rev-parse --short HEAD)"
git -C "$tmp" push -q -f "$remote" gh-pages
echo "Published. Pages will show it within a minute."
