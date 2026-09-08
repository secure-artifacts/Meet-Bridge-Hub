# Meet Bridge Hub

## 0.1.3

- 修复跨 Profile N-1 路由、无上行接收端、Hub 麦克风显式接收端选择，以及断线与音频电平诊断。

Meet Bridge Hub is the desktop companion for the Meet Bridge browser extension. This repository contains two deliberately separate deliverables:

- `apps/`, `crates/`, and `packaging/`: the Tauri desktop application for macOS and Windows.
- `extensions/meet-bridge-n-minus-one/`: the current browser extension source. It is retained here for version coordination, but is **not** packaged or published by this repository's software-release workflow.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/tauri-app` | Tauri desktop shell and static frontend |
| `crates/hub-core` | Hub, pairing, microphone, and mixer services |
| `crates/native-broker` | Native Messaging broker used by Chrome integration |
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

The existing native-host installer is implemented only for macOS. The Windows desktop package is built without changing the tested mixer/service code, but browser-extension Native Messaging installation on Windows remains unavailable until a separately specified Windows installer design is implemented.
