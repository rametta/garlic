---
name: release-patch-tag
description: Bumps `package.json` by one patch version, runs the repo's required formatting and lint checks, pushes the release commit, then creates and pushes a matching annotated `vX.Y.Z` tag to trigger the CI release pipeline. Use when the user explicitly asks to bump the patch version, cut a release, create a release tag, or trigger the release workflow.
---

# Release Patch Tag

Use this skill for Garlic's explicit patch-release flow.

## Repo Facts

- The release workflow is triggered by pushing tags that match `v*`.
- `.github/workflows/release.yml` strips the leading `v` and syncs that version into `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` during CI.
- In this repo, prior release bump commits use the bare version string as the commit message, such as `0.0.7`.
- Do not use `npm version` or similar commands that create the tag automatically. The required order is: bump version, commit, push branch, create tag on that pushed commit, push tag.

## Workflow

1. Inspect the current repo state before making changes.
   - Run `git status --short --branch`.
   - If the worktree is dirty, stop and ask the user how to proceed.
   - Confirm the current branch is not detached.
   - Confirm the `origin` remote exists.

2. Determine the next patch version.
   - Read `package.json`.
   - Parse the current `version` as SemVer `MAJOR.MINOR.PATCH`.
   - Increment only the patch number.
   - If the version is missing or not a plain SemVer, stop and ask.

3. Update `package.json`.
   - Edit only the `version` field unless the user asked for more.
   - Keep the file formatted with 2-space indentation and a trailing newline.

4. Run the repo's required verification after editing JSON.
   - Run `bun run fmt`.
   - Run `bun run lint`.
   - If either command fails, stop and report the failure.
   - If formatting changes files unrelated to the release edit, review carefully and ask before including unrelated changes.

5. Commit and push the release commit.
   - Stage only the intended release files.
   - Use the new bare version string as the default commit message, for example `0.0.8`.
   - Push the current branch to its remote.
   - Never force-push unless the user explicitly asks.

6. Create and push the release tag.
   - Create an annotated tag named `v<version>` at `HEAD`.
   - Use the message `Release v<version>`.
   - Push that tag to `origin`.
   - If the tag already exists locally or remotely, stop and ask before changing anything.

7. Verify and report.
   - Confirm `git rev-parse HEAD` matches the commit referenced by the new tag.
   - Confirm the tag push succeeded.
   - Tell the user the new version, commit SHA, branch name, and tag name.
   - Mention that pushing the `v<version>` tag should trigger the release pipeline.

## Command Notes

- Prefer direct file edits for the version bump so tag creation stays under explicit control.
- Use an annotated tag command in this form:

```bash
git tag -a "v0.0.8" -m "Release v0.0.8"
```

- Push the tag explicitly:

```bash
git push origin "v0.0.8"
```

## Response Pattern

When the workflow succeeds, report:

```text
Released 0.0.8 on <branch>.
Pushed commit <sha> and tag v0.0.8.
The tag push should trigger the CI release pipeline.
```
