#!/usr/bin/env bash
set -e

TGZ=$(ls "./$WORKSPACE_PATH"/*.tgz 2>/dev/null | head -1)
if [ -z "$TGZ" ]; then
  echo "No .tgz found in ./$WORKSPACE_PATH — did the build step run?" >&2
  exit 1
fi

if $LD_RELEASE_IS_DRYRUN ; then
  echo "Dry run — would publish: $TGZ"
else
  if $LD_RELEASE_IS_PRERELEASE ; then
    echo "Publishing with prerelease tag: $TGZ"
    npm publish --tag prerelease --provenance --access public "$TGZ" || { echo "npm publish failed" >&2; exit 1; }
  else
    echo "Publishing: $TGZ"
    npm publish --provenance --access public "$TGZ" || { echo "npm publish failed" >&2; exit 1; }
  fi
fi
