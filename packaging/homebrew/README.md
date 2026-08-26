# Homebrew tap

`brew install guillermolg00/tap/moldig` installs the published npm tarball with Homebrew's own
`node`. There is no compiled binary in v1: the formula is the npm package, and Homebrew's
`std_npm_args` installs its `dependencies` with it, so `trash` arrives along with the bundle.

The formula lives in a personal tap, not in homebrew-core: homebrew-core requires a notability a
young repository cannot meet.

- **Tap repository**: `guillermolg00/homebrew-tap` (`brew tap guillermolg00/tap` resolves to it).
- **Formula path in the tap**: `Formula/moldig.rb`.
- **The formula is generated, never hand-edited.** Everything that changes between releases is
  the `url` and the `sha256`, and both come from the registry.

## Once: create the tap

```sh
brew tap-new guillermolg00/tap
```

or create `github.com/guillermolg00/homebrew-tap` on GitHub with a `Formula/` directory. Nothing
in this repository creates or pushes it.

## Per release: generate and push the formula

The version must already be published on npm — the generator reads the registry, not this
checkout. Follow [`docs/release.md`](../../docs/release.md) first.

```sh
node packaging/homebrew/generate-formula.mjs 0.1.0
# or straight into a tap checkout:
node packaging/homebrew/generate-formula.mjs 0.1.0 --out ~/Work/homebrew-tap/Formula
```

What it does, in order:

1. reads `https://registry.npmjs.org/moldig/<version>` for the tarball URL and the published
   `dist.integrity`;
2. downloads the tarball to a temp directory;
3. verifies it against that sha512 — **a mismatch aborts**, so a bad download can never be baked
   into the tap;
4. computes the sha256 hex with `node:crypto` (Homebrew wants sha256; the registry offers only
   sha1 and sha512);
5. writes `moldig.rb` and prints its path on stdout. Progress goes to stderr, so
   `FORMULA=$(node packaging/homebrew/generate-formula.mjs 0.1.0)` works.

It never runs `brew`, never pushes and needs no credentials. It uses only `fetch`, `node:crypto`
and `node:fs` — no dependency to install.

Then, in the tap checkout:

```sh
cp moldig.rb <tap>/Formula/moldig.rb
git -C <tap> add Formula/moldig.rb
git -C <tap> commit -m "moldig 0.1.0"
git -C <tap> push
```

## Verify

```sh
brew update
brew install guillermolg00/tap/moldig
brew test moldig
brew audit --strict --online guillermolg00/tap/moldig
moldig scan            # on the real home, not the sandbox
```

`brew test` runs with `HOME` pointed at an empty sandbox directory, so the formula's test block
asserts two things that hold there: `moldig --version` prints the formula's version, and
`moldig scan --json` prints an index with `"schemaVersion":0`. `scan --json` is compact by
default, which is why the assertion has no space after the colon.

## Notes

- `depends_on "node"` resolves to Homebrew's `node` formula, which tracks Current. The
  `ubuntu × node 26` CI leg covers that Node line, and the CLI's own startup check refuses
  anything below Node 22.18 whatever the formula says.
- Windows, and Linux without Homebrew, stay on npm. There is no scoop, winget or apt packaging
  in v1.
- If a release is ever yanked, regenerate the formula for the replacement version rather than
  editing the `url` and `sha256` by hand.
