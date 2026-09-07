# Secure release process

The release workflow follows the referenced developer security standard and is
designed so the attested bytes are exactly the bytes uploaded to the GitHub
Release.

## Non-negotiable rules

1. Releases are triggered only by pushing a `v*` Git tag.
2. The tag must exactly match `manifest.json`, for example tag `v0.0.2` and
   manifest version `0.0.2`.
3. The workflow creates one final ZIP exactly once.
4. `actions/attest-build-provenance@v2` signs that final ZIP path.
5. `gh attestation verify` verifies the same file before upload.
6. `softprops/action-gh-release@v2` uploads that same file using the default
   `GITHUB_TOKEN`.
7. Never upload, replace, recompress, rename, or edit a Release asset manually.
8. A failed release must be corrected in source and published with a new patch
   version and new tag.

The release job grants exactly the required permissions:

```yaml
permissions:
  id-token: write
  contents: write
  attestations: write
```

## Before tagging

```bash
npm test
npm run build
```

Inspect `dist/extension/`; it is generated from the explicit allowlist in
`scripts/release-files.mjs`. Diagnostic exports, screenshots, local settings,
archives, keys, environment files, and unrelated repository files cannot enter
the Release package.

## Publish

```bash
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin v0.0.2
```

Do not create the Release manually. Wait for the `Release Browser Extension`
workflow.

## Verify after publication

Confirm that the only Release asset was uploaded by `github-actions[bot]`, then
download it and run:

```bash
gh attestation verify Meet-Bridge-N-1-v0.0.2.zip --repo secure-artifacts/Meet-Bridge-N-1
```

GitHub's `Verified` label alone is not sufficient for strict L2 verification.
The provenance must also identify the correct source repository, a GitHub-hosted
runner, the exact `refs/tags/v0.0.2` ref, and the bot uploader.
