#!/usr/bin/env bash

# Usage:
#   bun run deploy          # Bump the patch version
#   bun run deploy minor    # Bump the minor version
#   bun run deploy major    # Bump the major version
#   bun run deploy 1.2.3    # Set an explicit version

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

fail() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
}

if [[ -n "$(git status --porcelain)" ]]; then
  fail "the working tree must be clean before deploying"
fi

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  fail "cannot deploy from a detached HEAD"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  fail 'remote "origin" is not configured'
fi

current_version="$(node -p "require('./package.json').version")"
semver_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ ! "$current_version" =~ $semver_pattern ]]; then
  fail "package.json version \"$current_version\" is not a plain semantic version"
fi

current_major="${BASH_REMATCH[1]}"
current_minor="${BASH_REMATCH[2]}"
current_patch="${BASH_REMATCH[3]}"
requested_version="${1:-patch}"

case "$requested_version" in
  major)
    version="$((current_major + 1)).0.0"
    ;;
  minor)
    version="${current_major}.$((current_minor + 1)).0"
    ;;
  patch)
    version="${current_major}.${current_minor}.$((current_patch + 1))"
    ;;
  *)
    if [[ ! "$requested_version" =~ $semver_pattern ]]; then
      fail "usage: bun run deploy [patch|minor|major|X.Y.Z]"
    fi

    next_major="${BASH_REMATCH[1]}"
    next_minor="${BASH_REMATCH[2]}"
    next_patch="${BASH_REMATCH[3]}"
    if ((next_major < current_major)) ||
      ((next_major == current_major && next_minor < current_minor)) ||
      ((next_major == current_major && next_minor == current_minor && next_patch <= current_patch)); then
      fail "new version $requested_version must be greater than current version $current_version"
    fi
    version="$requested_version"
    ;;
esac

tag="v${version}"
if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
  fail "tag $tag already exists locally"
fi

set +e
git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1
remote_tag_status=$?
set -e
if ((remote_tag_status == 0)); then
  fail "tag $tag already exists on origin"
fi
if ((remote_tag_status != 2)); then
  fail "could not check whether $tag exists on origin"
fi

node -e '
  const fs = require("node:fs");
  const path = "package.json";
  const packageJson = JSON.parse(fs.readFileSync(path, "utf8"));
  packageJson.version = process.argv[1];
  fs.writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
' "$version"

bun run fmt
bun run lint

if [[ "$(git status --porcelain)" != " M package.json" ]]; then
  fail "expected package.json to be the only changed file after updating the version"
fi

git add -- package.json
git commit -m "$version"
git push origin "$branch"
git tag -a "$tag" -m "Release $tag"
git push origin "$tag"

printf 'Released %s on %s with tag %s.\n' "$version" "$branch" "$tag"
