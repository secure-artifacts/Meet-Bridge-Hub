# Meet Bridge Hub

## 0.1.5

- 修复 Windows 15.6ms 定时粒度造成的混音时钟降速，同时保留跨 Profile N-1、250ms 延迟上限和逐样本完整性验证。

Meet Bridge Hub is the desktop companion for the Meet Bridge browser extension. This repository contains two deliberately separate deliverables:

- `apps/`, `crates/`, and `packaging/`: the Tauri desktop application for macOS and Windows.
- `extensions/meet-bridge-n-minus-one/`: the current browser extension source. It is retained here for version coordination, but is **not** packaged or published by this repository's software-release workflow.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/tauri-app` | Tauri desktop shell and static frontend |
| `crates/hub-core` | Hub, pairing, microphone, and mixer services |
| `crates/native-broker` | Native Messaging broker used by Chrome and Edge integration |
| `extensions/meet-bridge-n-minus-one` | Independently released browser extension |
| `.github/workflows/release.yml` | Tagged desktop-release workflow with provenance attestations |

## Local checks

Run the desktop test suite from the repository root:

```bash
cargo test
```

Run extension checks separately; this does not publish or package the extension:

```bash
cd extensions/meet-bridge-n-minus-one
npm test
```

## How to publish a desktop version

Desktop releases are intentionally created only by GitHub Actions. Do not create a Release or upload an installer manually: the security review requires each released asset to be uploaded by `github-actions[bot]` and to have a matching build-provenance attestation.

1. Commit and push the desired desktop changes to `main`.

   ```bash
   git status
   git add .
   git commit -m "Describe the change"
   git push origin main
   ```

2. Create and push a version tag. Tags must begin with `v`.

   ```bash
   git tag -a v0.1.0 -m "Release version 0.1.0"
   git push origin v0.1.0
   ```

3. Wait for the **Build and release Meet Bridge Hub** workflow to pass. It builds a DMG on macOS and MSI/NSIS installers on Windows. In each platform job, the final file is attested immediately before GitHub Actions uploads it to the Release.

4. Check the Release page after the workflow succeeds. Do not replace, delete, or add assets in the GitHub web interface.

If a tagged build fails, fix the committed code or workflow, then delete and recreate the failed tag:

```bash
git tag -d v0.1.0
git push origin :refs/tags/v0.1.0
git tag -a v0.1.0 -m "Release version 0.1.0"
git push origin v0.1.0
```

## Important platform note

On Windows, starting Meet Bridge Hub installs or repairs the current-user Native Messaging registration for both Google Chrome and Microsoft Edge. Both browsers use the same manifest and the fixed Meet Bridge N-1 extension ID.

The Windows audio diagnostic log is stored at `%LOCALAPPDATA%\Meet Bridge Hub\Logs\hub-audio.ndjson`. Set `MEET_BRIDGE_AUDIO_LOG` before starting the Hub only when a custom diagnostic path is required.
