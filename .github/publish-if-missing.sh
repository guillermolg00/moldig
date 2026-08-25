#!/usr/bin/env bash
# Publish the tarball packed in the current package directory unless that version is already on
# npm, so a half-finished release run can be re-run safely.
set -euo pipefail
name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "$name@$version is already published, skipping"
  exit 0
fi
tarball="$(ls ./*.tgz)"
npm publish "$tarball" --access public --tag "${NPM_TAG:-latest}"
