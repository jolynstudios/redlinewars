# Releases

Every Redline Wars build that is distributed, with the tag that holds its source and how it was checked
against that tag (`tools/verify-release.mjs`, on a clean checkout of the tag built with `tools/build.mjs`).

## v2026.09.26-a87bf8d

Source: [`v2026.09.26-a87bf8d`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-a87bf8d), exported from private commit
`a87bf8d2b1a2`; `simBuild fd9882019bca`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 451965510 | `74f6725a67b231560ecca6e607934aa0eddf6d555caec6904b18ba23f616f8f2` |
| `Redline-Wars-macOS-arm64.zip` | 482103030 | `b70f0e45e68582349f4878bd0931000cc8ab18492c08665595be79a1b38f30ba` |
| `Redline-Wars-macOS-x64.zip` | 490880885 | `06acd52dd6e51c54117c10a67d9a4135871c5fde2d172d245f571002ae85fcb9` |
| `Redline-Wars-Linux-x64.AppImage` | 447681946 | `f79375d1080c27ff478d4b97a771b7ce97c4f1b542099223c3627a19643e97ba` |
| `Redline-Wars-Linux-arm64.AppImage` | 447758147 | `ed0d68c9160d4205bbb294dd6429280a2228002d4574f5134cca9aa0a0145c01` |
| `redline-node-linux-x64.zip` | 72353202 | `eff53d81ccdb2b47013c3ddbed9c4ec6fc7ad833393689085028eb5f1da385a5` |
| `redline-node-linux-arm64.zip` | 69608707 | `4829f7ee7f48a12d6fdd1a588b61bd57b1032aa7763befdd7033d2b8d8f16d1b` |
| `redline-node-win-x64.zip` | 108842845 | `a22f58e23ccbc9d1d30080a8712a6a1ee29248d0c33595f867e1516158b92e4c` |
| `redline-node-osx-arm64.zip` | 68175454 | `77f36d4b0624dd675c7368840a6809ab5b3f55923f4bbd6620ea003bf9b2a7dd` |
| `redline-node-osx-x64.zip` | 71366442 | `a93025c834b058c2380b38a1a286723ba6657f1c5d44f8c4c9f2a443963faf1e` |
| `SHA256SUMS` | 950 | `2b0369ba82873f67b70fbab8423a48c3c2682e9e8d64415e589ba6aaa071d361` |

**Verification: PASS** (`--sums SHA256SUMS --require-manifest`), for each artifact:
- its sha256 equals the `SHA256SUMS` line;
- its `RELEASE-MANIFEST.json` names this tag and source commit, and the build's `simBuild`;
- every node source file equals the tag's;
- every `web/src` file embedded in the desktop apps' source maps equals the tag's;
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries equal the tag's, and the
  third-party notices credit the engine and those libraries;
- a node zip carries no WebGPU client; a desktop app carries the AppBundle.

### The browser game: play.redlinewars.online

The build is identified by `https://play.redlinewars.online/steelseed/composition.json`, which lists every
file with its sha256. Its sha256 is `25864f51c6d18bf979e849374913df51a7e0e1f37ec610f4b3d79763b9f8f087`, and it lists 1163 files.

**Verification: PASS** (`--appbundle`, with the deploy run's own AppBundle):
- the live `build.json` carries the tag's `simBuild` and `modHash`;
- all 17 scripts the site serves match the composition's hashes;
- the site does not serve its source maps; the deploy's AppBundle carries the identical
  `composition.json`, and its 16 maps embed 173 files of `web/src`, all equal to the tag's;
- every WebAssembly runtime file the site serves (`_framework/`, 282 files) is the build's;
- the GPL text, OpenRA's AUTHORS, the licences of the bundled libraries and the third-party notices are
  served under `steelseed/licenses/`.

## v2026.09.26-4c6da14 (replaced the same day by v2026.09.26-a87bf8d)

Source: [`v2026.09.26-4c6da14`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-4c6da14), exported from private commit
`4c6da147cc10`; `simBuild fd9882019bca`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 451966816 | `3116888a6bcdc18b5b9438d2858b57bc477877ecc11f641472a35e3b1f5228c8` |
| `Redline-Wars-macOS-arm64.zip` | 482101921 | `0f770ee7a9346caed57aebea028161d9e3b53f042330c6109ac3c93ec1afa4ff` |
| `Redline-Wars-macOS-x64.zip` | 490879804 | `84b0502f40308a815bee145415fefa6228791a832a883886a6f4bb66a397fb3b` |
| `Redline-Wars-Linux-x64.AppImage` | 447681774 | `b864c83a58e5ca568ddc9744aabbc1bf2df6187dea7a01738e11c9cea328f046` |
| `Redline-Wars-Linux-arm64.AppImage` | 447758040 | `2f5120eca61de9781c2b84d80b8675aba4a2a5d9363d5141471afd410fab8564` |
| `redline-node-linux-x64.zip` | 72353219 | `2dc1057cdcdfe897bc9761428fd0c8386b5e33bae722a5507da4029bc3d6b011` |
| `redline-node-linux-arm64.zip` | 69608722 | `8fa67254fe646dcc467c78ff604c172764582324d8d2b24a3c2a74da568d48e8` |
| `redline-node-win-x64.zip` | 108842853 | `0bda03ab98a92102513ad2cf5e5837986083dcf5ace470ce6c06a3240e6754d5` |
| `redline-node-osx-arm64.zip` | 68175472 | `524820cdc45800bf4e8725d6ac6f27219ce23a42e11bc1d5fa037c6a8679d5dc` |
| `redline-node-osx-x64.zip` | 71366464 | `cb6cff1de2851ec5247e30c361c3e585345cdde3666b8d78931b18fd9595386f` |
| `SHA256SUMS` | 950 | `b83575e4aa4461efd7ea80a9357c633e03d939c4fe3b9b40c8ddfee30d91bae6` |

**Verification: PASS** (`--sums SHA256SUMS --require-manifest`), for each artifact:
- its sha256 equals the `SHA256SUMS` line;
- its `RELEASE-MANIFEST.json` names this tag and source commit, and the build's `simBuild`;
- every node source file equals the tag's;
- every `web/src` file embedded in the desktop apps' source maps equals the tag's;
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries equal the tag's, and the
  third-party notices credit the engine and those libraries;
- a node zip carries no WebGPU client; a desktop app carries the AppBundle.

### The browser game: play.redlinewars.online

The build is identified by `https://play.redlinewars.online/steelseed/composition.json`, which lists every
file with its sha256. Its sha256 is `784931b6b48e47c2081fa90a8d38f8408fa397ea8267db85e73f377264b61a3d`, and it lists 1163 files.

**Verification: PASS** (`--appbundle`, with the deploy run's own AppBundle):
- the live `build.json` carries the tag's `simBuild` and `modHash`;
- all 17 scripts the site serves match the composition's hashes;
- the site does not serve its source maps; the deploy's AppBundle carries the identical
  `composition.json`, and its 16 maps embed 173 files of `web/src`, all equal to the tag's;
- every WebAssembly runtime file the site serves (`_framework/`, 282 files) is the build's;
- the GPL text, OpenRA's AUTHORS, the licences of the bundled libraries and the third-party notices are
  served under `steelseed/licenses/`.

## Not distributed

- **`@steelthorn/node` (the npm node package):** not published to npm. It exists only as a CI artifact.
- **The art baseline:** the separately licensed art packs live in a private release; they hold no program
  code.
