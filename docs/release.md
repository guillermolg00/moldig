# Release runbook

How a version of moldig reaches npm, and how the first one reaches the world. Both packages
always share one version (`@moldig/core` and `moldig`), the tag is `v<version>`, and the
changelog is the GitHub Release `changelogithub` writes from the conventional commits since the
previous tag — there is no `CHANGELOG.md`.

Everything below runs on Guillermo's machine with Guillermo's credentials. **An agent may
prepare, rehearse and verify; it never pushes, never tags and never publishes.**

## Preconditions

- Both packages exist on npm at `0.0.0`, published 2026-08-25 under the npm org `moldig`
  (publisher `guillermolg00`).
- The trusted publisher `guillermolg00/moldig` → `release.yml` is configured on both, with
  "Require 2FA and disallow tokens". There is no `NPM_TOKEN` anywhere, and `release.yml` sets no
  `registry-url`: authentication is the OIDC id-token.
- `main` is green on all five CI legs (ubuntu 22.18 / 24 / 26, macOS 24, Windows 24).

## The steps for `v0.1.0`

### 1. Push `main`

```sh
git push origin main
git push origin proto/interactive-flow   # the prototype, kept as the interactive experience's reference
```

### 2. Wait for CI on the three operating systems

`ci.yml` runs five legs and `fail-fast: false`, so a failure on one still reports the others. A
red Windows leg is fixed, not skipped: it is the only leg that exercises junctions, backslash
escaping inside JSON and TOML fixtures, the `json_valid()`-branched SQLite rewrite, 8.3 short
temp paths and drive-letter folding.

```sh
gh run list --branch main --limit 5
gh run watch
```

### 3. Decide whether `docs/` enters git

`/docs/` is in `.gitignore` today; only this runbook is tracked (force-added). Before the
repository goes public, decide whether the ADRs and the research notes join it.

If yes:

```sh
# grep the research notes for anything machine-specific first
grep -rniE '/Users/[a-z]|guillermo|@gmail|ssh-|sk-|ghp_' docs/
```

The redaction rule is: names, keys, paths and counts of *structure* only — no real directory
names of this machine, no logins, no tokens. Then:

```sh
# replace the `/docs/` line in .gitignore with nothing, keeping /.scratch/
git add docs .gitignore
git commit -m "docs: track the ADRs and research notes"
```

`.scratch/` stays ignored either way — it is the planning effort, not documentation.

### 4. Rehearse the bump (optional now; see "What `bun run release` actually does")

The behaviour below was verified on 2026-08-26 against bumpp 12.2.1 and bun 1.4.0. Re-rehearse
only if either is bumped:

```sh
git switch -c rehearse/bumpp
bunx bumpp -r --execute 'bun install' --release 0.1.0 --no-tag --no-push --yes
git show --stat HEAD          # expect exactly the two packages/*/package.json
git status --short            # expect clean
git switch - && git branch -D rehearse/bumpp
bun install
```

Never pass `--tag` or `--push` in a rehearsal, and never create a `v*` tag that could reach the
remote.

### 5. `bun run release`

**The point of no return.** Only on an explicit go.

```sh
bun run release      # = bumpp -r --execute 'bun install'
```

bumpp prompts for the release type — choose `0.1.0` — rewrites `version` in both workspace
`package.json` files, runs `bun install`, commits `chore: release v0.1.0`, tags `v0.1.0` and
pushes both the commit and the tag.

A prerelease (`0.2.0-beta.1`) publishes under the npm dist-tag `next`; everything else under
`latest`. `release.yml` decides that from the `-` in the version, not from a flag.

### 6. Watch `release.yml`

The tag push triggers it. The `publish` job, on ubuntu with Node 24 (npm ≥ 11.5.1 is required
for trusted publishing):

1. **the guard** — the tag must equal `v<cli version>`, and core's version must equal the CLI's;
   it sets `NPM_TAG=next` when the version contains `-`, else `latest`;
2. `bun install --frozen-lockfile`, `bun run check`, `bun run test`, `bun run build`;
3. the smoke run — `node packages/cli/dist/cli.mjs` must exit 0 on a runner with no harness
   state, which is the non-TTY path: the final frame plus the shareable summary;
4. `bun pm pack` in **both** packages before publishing **either**, so a packing failure cannot
   strand a half-published pair;
5. `.github/publish-if-missing.sh` in `packages/core`, then in `packages/cli`.

Then the `github-release` job checks out with `fetch-depth: 0` and runs `bunx changelogithub`
with `GITHUB_TOKEN` to write the release notes.

```sh
gh run watch
```

A scoped package can take about two minutes to reach npm's read replica, so a `npm view` right
after the publish step may still 404.

### 7. Verify from a clean directory

```sh
cd "$(mktemp -d)"
npx --yes moldig@0.1.0 scan
npx --yes moldig@0.1.0 scan --json | node -e 'process.stdin.once("data",d=>console.log(JSON.parse(d).schemaVersion))'
npx --yes moldig@0.1.0 audit; echo "exit $?"
npm view moldig@0.1.0 dist-tags
npm view moldig@0.1.0 dependencies      # expect exactly { trash: '10.1.1' }
```

`schemaVersion` must be `0`, `audit` must exit 0 or 1 (never 2), and `dist-tags` must show
`latest`.

### 8. Make the repository public

Settings → General → Danger Zone → Change visibility. From here on every publish carries npm
provenance automatically: trusted publishing attaches it once the package is public **and** the
GitHub repository is public. `0.1.0` therefore carries no provenance and `0.1.1`+ do — this
order is deliberate (D102), and `--provenance` is never passed by hand.

### 9. Homebrew

See [`packaging/homebrew/README.md`](../packaging/homebrew/README.md). The tap is
`guillermolg00/homebrew-tap`, created once by Guillermo; the formula is generated from the
published npm tarball and updated by hand per release in v1.

## What `bun run release` actually does

`bun run release` = `bumpp -r --execute 'bun install'`. Rehearsed on 2026-08-26 with bumpp
12.2.1 and bun 1.4.0:

- **The release commit contains exactly two files**: `packages/cli/package.json` and
  `packages/core/package.json`. The root `package.json` has no `version` field, so bumpp reports
  `did not need to be updated` — that is correct, not a failure.
- **`bun.lock` does not enter the commit, because `bun install` does not change it.** The lock
  does record each workspace package's `version`, but bun 1.4.0's `bun install` leaves those
  fields alone; `--execute 'bun install'` prints `no changes` and the working tree is clean
  after the commit.
- **`--all` is therefore unnecessary** on the `release` script. Adding it would sweep unrelated
  modified files into the release commit for no gain.
- **`bun install --frozen-lockfile` still succeeds** with `bun.lock` saying `0.0.0` while the
  manifests say `0.1.0` — verified. So neither `ci.yml` nor `release.yml` breaks on the drift.
- The consequence is cosmetic: `bun.lock` keeps naming the previous version for the two
  workspace packages. Nothing reads it (neither package ships it — `files` is `dist` for the
  CLI and `dist` + `src` for core), and it is only ever a lockfile for this repository. To
  resync it deliberately:

  ```sh
  rm bun.lock && bun install
  git commit -am "chore: resync bun.lock with the released version"
  ```

  Do that as its own `chore:` commit, never inside the release commit.

## When a publish fails halfway

`.github/publish-if-missing.sh` exists for exactly this. It reads `name` and `version` from the
package directory it runs in, asks `npm view <name>@<version> version`, and **skips** if that
version is already on the registry; otherwise it publishes the packed tarball with
`--access public --tag "$NPM_TAG"`.

So the recovery is always the same: **fix the cause and re-run the same tag's workflow.** The
step that already succeeded prints `<name>@<version> is already published, skipping` and the one
that failed runs again.

```sh
gh run rerun <run-id> --failed
```

Cases:

| What failed | What to do |
|---|---|
| The gate (`check`, `test`, `build`) or the smoke run | Nothing was published. Fix on `main`, then delete and re-cut the tag: `git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`, then `git tag v0.1.0 && git push origin v0.1.0`. Safe only because nothing reached npm |
| `@moldig/core` published, `moldig` did not | Re-run the workflow for the same tag. Core is skipped, the CLI publishes. **Do not bump the version** — a lockstep pair at different versions is worse than a re-run |
| Both published, `github-release` failed | npm is correct and done. Re-run the failed job, or write the release notes by hand from `git log v0.0.0..v0.1.0` |
| The wrong version reached npm | npm versions are immutable and unpublish is only available for 72 hours and breaks anyone who installed it. Publish a corrected patch instead, and `npm dist-tag add moldig@<good> latest` if the bad one grabbed `latest` |
| The guard failed (`tag != version`) | Nothing was published. Delete the tag, fix the version, tag again |

Never re-run a release by re-cutting a tag that already published. Never pass `--provenance`.
Never publish with `bun publish` — `npm publish` is what trusted publishing understands.

## Every release after the first

1. Land the work on `main` with conventional commits (`feat(core):`, `fix(cli):`, `docs:`,
   `chore(deps):`, `test:`, `ci:`; breaking changes marked `!`) — they are the changelog.
2. CI green on all five legs.
3. `bun run release`, choose the type.
4. Watch `release.yml`.
5. Verify with `npx --yes moldig@<version> scan --json`.
6. Regenerate and push the Homebrew formula (`packaging/homebrew/`).
