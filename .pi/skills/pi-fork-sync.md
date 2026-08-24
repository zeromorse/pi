---
name: pi-fork-sync
description: Sync the zeromorse/pi fork with upstream earendil-works/pi, merge main into my-main, and push both branches. Covers remote layout, fast-forward rules, CHANGELOG merge conflicts, and the PAT workflow-scope push failure.
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

If the working tree is dirty, stop and ask the user; never stash or reset.

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

### CHANGELOG conflict pattern

Upstream releases move old `[Unreleased]` entries into a version section (e.g. `## [0.84.3]`), while `my-main` has its own entries under `[Unreleased]`. Both files `packages/*/CHANGELOG.md` then conflict. Resolution rule:

- Take the upstream (main) side verbatim for the released section.
- Re-add the fork-only entries under `## [Unreleased]` at the top of the file (they are unpublished; released sections are immutable).

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
