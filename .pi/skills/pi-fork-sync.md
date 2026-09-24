---
name: pi-fork-sync
description: Sync the zeromorse/pi fork with upstream earendil-works/pi, merge main into my-main, and push both branches. Covers remote layout, fast-forward rules, the launchd pi-sync automation that resolves conflicts headlessly, CHANGELOG and docs-refactor merge conflict patterns, and the PAT workflow-scope push failure.
---

# Sync pi Fork and Merge main into my-main

Remote layout of this repo:

- `origin` = `https://github.com/earendil-works/pi.git` (upstream)
- `fork` = `https://github.com/zeromorse/pi.git` (personal fork)
- Working branch: `my-main` (fork-only feature commits); `main` tracks upstream only.

Goal: bring upstream `origin/main` into local `main`, mirror it to `fork/main`, merge it into `my-main`, push `my-main` to fork.

## 1. Preflight

```bash
git status --short          # must be clean before switching branches
git remote -v               # confirm origin=upstream, fork=personal
```

If the working tree is dirty, do not immediately assume it is manual work to finish. Check whether the daily pi-sync automation is mid-run first (next section); if it is not, stop and ask the user; never stash or reset.

### Detect an in-flight pi-sync automation (never race it)

The launchd pi-sync job resolves merge conflicts itself:

- `local/pi-sync/pi-sync-merge-changelog.py` auto-resolves CHANGELOG conflicts.
- `local/pi-sync/pi-sync-ai-resolve.sh` delegates remaining code conflicts to a headless `pi -p` (30 min timeout). The headless run resolves and `git add`s files but never commits; the script then verifies (HEAD unchanged, no unmerged paths, no conflict markers, `npm run check`, `./test.sh`) and the caller commits on success or aborts the merge on failure.

Before touching a dirty tree or a mid-merge state:

```bash
ps aux | grep 'pi-sync-ai-resolve' | grep -v grep
tail ~/Library/Logs/pi-sync.log     # look for "starting pi headless conflict resolution"
```

If the automation is running:

- Do NOT edit conflicted files and do NOT run git commands that touch the index; a second writer corrupts the headless run's work.
- Monitor via `tail -f ~/Library/Logs/pi-sync.log`. The headless session trace is the newest jsonl under `~/.pi/agent/sessions/--Users-duanyanlong-agent-pi--/` whose timestamp matches the merge start (log line `starting pi headless conflict resolution (N files, ...)`).
- Signs another agent is mid-resolution: files still `UU` but their conflict markers are already gone, or their content matches neither `git show :2:<file>` (ours) nor `:3:<file>` (theirs). Treat that as "in progress", not "resolved but forgotten to add" — the headless run stages files in bulk at the end.

## 2. Update local main (fast-forward only)

```bash
git fetch origin main
git checkout main
git merge --ff-only origin/main
```

`--ff-only` guarantees local `main` never diverges from upstream. If it refuses, the local branch has commits not on upstream — stop and ask the user.

## 3. Sync fork/main

```bash
git push fork main
```

## 4. Merge main into my-main

```bash
git checkout my-main
git merge main --no-edit
```

The daily pi-sync job runs this same merge and resolves conflicts automatically (CHANGELOGs via the merge-changelog script, code conflicts via the headless AI resolver, plus rerere preimage reuse). The conflict patterns below are for a manual merge run — and for auditing what the automation should have produced.

### CHANGELOG conflict pattern

Upstream releases move old `[Unreleased]` entries into a version section (e.g. `## [0.84.3]`), while `my-main` has its own entries under `[Unreleased]`. Both files `packages/*/CHANGELOG.md` then conflict. Resolution rule:

- Take the upstream (main) side verbatim for the released section.
- Re-add the fork-only entries under `## [Unreleased]` at the top of the file (they are unpublished; released sections are immutable).

### Upstream docs refactor conflict pattern

Upstream occasionally rewrites the docs wholesale (e.g. #9898 split `rpc.md` into `rpc.md` + `rpc-commands.md` + `rpc-extension-ui.md`, and rewrote settings/usage/sessions/extensions). The conflict shape is lopsided: ours = the old big file carrying fork edits, theirs = a new slim file, with the old content moved into newly created files. Resolution rule:

1. Take theirs for the slimmed file: `git show MERGE_HEAD:<file> > <file>`.
2. List the fork-only commits that touched the old file: `git log --oneline main..my-main -- <file>`.
3. Verify each fork-only feature still exists in code (upstream may have absorbed it) before writing docs for it — e.g. the RPC `new_session`/`fork`/`clone` `name` parameter is still `name?: string` in `packages/coding-agent/src/modes/rpc/rpc-types.ts`.
4. Migrate the surviving fork-only semantics into the newly split file by hand — e.g. the `name` parameter docs go into the `new_session`, `fork`, and `clone` sections of `rpc-commands.md`.

Beware the near-miss: a `git show MERGE_HEAD:... >` overwrite while the headless resolver is also working on that file is a write-write race. Only do manual resolution when the automation check above says nothing is running.

After editing, verify no conflict markers remain, then:

```bash
git add <resolved files>    # explicit paths only
git commit --no-edit
```

## 5. Push my-main

```bash
git push fork my-main
```

## 6. Known Failure: credential cannot push

### Classic PAT missing `workflow` scope

Pushing branches whose diff touches `.github/workflows/*` fails with:

```
! [remote rejected] main -> main (refusing to allow a Personal Access Token
  to create or update workflow `.github/workflows/build-binaries.yml` without `workflow` scope)
```

Default credential (credential.helper = osxkeychain) is a classic PAT without the `workflow` scope. Fails identically via git push and via REST `POST /repos/zeromorse/pi/merge-upstream` (HTTP 422, same message). Fix: edit the token at https://github.com/settings/tokens, add `workflow` scope.

### Fine-grained PAT with no write permissions

A fine-grained PAT (`github_pat_...`) without Contents write fails with a different, less descriptive error:

```
remote: Permission to zeromorse/pi.git denied to zeromorse.
fatal: unable to access 'https://github.com/zeromorse/pi.git/': The requested URL returned error: 403
```

API returns `403 {"message": "Resource not accessible by personal access token"}`.

Diagnosis sequence (non-destructive, write to /tmp scripts, never inline the token):

1. `GET /user` with the token -> confirms identity (login must be zeromorse).
2. `GET /repos/zeromorse/pi` -> **ignore** the `permissions` field: it reflects the user's owner role, not what the token is granted.
3. Minimal write probe: push a commit that already exists on the fork to a temp ref
   (`git push <url> b7bb00b93:refs/heads/test-perm`), or `POST /repos/zeromorse/pi/git/refs`
   with that sha, then delete the ref. 403 here = Contents write missing, independent of workflow files.

Required fine-grained PAT settings (https://github.com/settings/personal-access-tokens):

- Repository access includes `zeromorse/pi`
- Contents: **Read and write**
- Workflows: **Read and write** (the sync diff touches `.github/workflows/build-binaries.yml`)

Push with an explicit URL so the keychain credential is bypassed:

```bash
URL="https://zeromorse:${TOKEN}@github.com/zeromorse/pi.git"
git push "$URL" main:main
```

Never persist the token in remotes, git config, docs, skills, or any file that survives the session. The one correct place to persist it is the macOS keychain (see below). After editing token permissions on GitHub, no re-issue is needed: the same token string works.

### Keychain credential management

`credential.helper = osxkeychain` is the default credential source for `git push`/`git pull` over HTTPS. Current entry: server `github.com`, account `zeromorse`.

Update it when the PAT changes or expires (fine-grained PATs have a user-set expiry; after expiry pushes start failing with the errors above):

```bash
# via a /tmp script so the token never enters shell history
security add-internet-password -U -s github.com -a zeromorse -w "$TOKEN"
```

The entry name/protocol stay unchanged; `-U` overwrites only the password field. May pop an authorization dialog.

Verify the new credential with a real write (an "Everything up-to-date" push skips authentication on a public repo and proves nothing):

```bash
git push fork <existing-sha>:refs/heads/test-cred   # real write through keychain auth
git push fork --delete test-cred                      # cleanup
```

Do not work around any of this by rewriting history, force-pushing, or excluding workflow files.

## 7. Completion checks

```bash
git fetch fork
git log --oneline -1 fork/main   # matches origin/main
git log --oneline -1 fork/my-main # matches local my-main merge commit
git status --short               # clean
```
