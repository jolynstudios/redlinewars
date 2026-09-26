# Shipped dependencies: audit

Audited from the distributed artifacts themselves: what each package carries, under which licence, and
what that licence asks of us. The notices themselves are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## What each artifact carries

| Artifact | Third-party code inside |
|---|---|
| Browser game (`play.redlinewars.online/steelseed/`) | the .NET WebAssembly runtime; the OpenRA library assemblies as `_framework/*.wasm`, among them `FuzzyLogicLibrary`, `MP3Sharp`, `TagLibSharp`, and compiled ahead of time into `dotnet.native.wasm`; the Archivo and Martian Mono fonts (OFL) |
| Desktop apps (Windows, macOS, Linux) | the same AppBundle; Electron 44.4.5 with Chromium; the community node: ws 8.21.3; the self-contained .NET server (`bin-standalone/<rid>/`: `TagLibSharp`, `Eluant`, `lua51`, SharpZipLib, Linguini, Mono.Nat); the ranked replay verifier (`ranked-replay-verifier/`: all OpenRA libraries including `FuzzyLogicLibrary`, `MP3Sharp`, `TagLibSharp`) |
| Community node zips (5 RIDs) | the node (ws 8.21.3), the self-contained server and the replay verifier as above; the Windows zip adds Node.js v24.21.0 (`runtime/node.exe`) |
| npm node package (`@steelthorn/node`) | not distributed: it is not published on npm and exists only as a short-lived CI artifact |

## Licences that ask something of us

| Component | Licence | What it asks | Status |
|---|---|---|---|
| OpenRA (the engine) | GPL-3.0-or-later | corresponding source of every distributed version; licence and notices with the binaries | a source tag for each distributed version ([RELEASES.md](RELEASES.md)); the GPL text, OpenRA's AUTHORS and the notices ship in every artifact, and `tools/verify-release.mjs` checks them byte for byte |
| Redline Wars' own code | GPL-3.0-or-later | as above | as above |
| MP3Sharp 1.0.5 | LGPL-3.0 | the LGPL and GPL texts; the library's source; the ability to relink with a modified library | `LGPL-3.0.txt` and the GPL text ship in every artifact (`engine/licenses/`); source at https://github.com/Nihlus/MP3Sharp and inside the NuGet package (`src/`); relinking: the whole program's source is here and `tools/build.mjs` rebuilds it with a replaced library |
| TagLib# (TagLibSharp 2.3.0) | LGPL-2.1-only | the LGPL text; the library's source; the ability to relink | `LGPL-2.1.txt` ships in every artifact (`engine/licenses/`); source at https://github.com/mono/taglib-sharp/tree/TaglibSharp-2.3.0.0; relinking as above |
| FuzzyLogicLibrary (OpenRA-FuzzyLogicLibrary 1.0.1) | GPL, version open (below) | the GPL text; source | source at https://github.com/teinarss/fuzzynet; the GPL v2 text ships in every artifact (`engine/licenses/GPL-2.0.txt`); **version open** |
| Fonts: Archivo, Martian Mono | OFL-1.1 | the OFL text next to the fonts | shipped (`licenses/` in the AppBundle, `legal/fonts/` in the desktop apps, and on the website) |
| Electron, Chromium, Node.js, ws, .NET, Lua and the MIT libraries | MIT, BSD-style, Unicode | the licence and copyright notices | Electron's and Chromium's ship inside every desktop app; Node.js's inside the Windows node zip; the others in the third-party notices, which ship in every artifact |

## Rebuilding with a modified LGPL library

MP3Sharp and TagLib# are NuGet package references of `OpenRA.Mods.Common`
(`engine/openra/OpenRA.Mods.Common/OpenRA.Mods.Common.csproj` and
`engine/OpenRA.Mods.Common/OpenRA.Mods.Common.csproj`). To use a modified version:
1. build it as a NuGet package in a local feed (`dotnet pack`, then `dotnet nuget add source <folder>`),
   or build the assembly and replace the `<PackageReference>` with a `<Reference>` to it. Give the package
   a new version number and reference that version: a package already in the NuGet cache under the old
   version is used without a warning;
2. run `node tools/build.mjs`: it rebuilds the WebAssembly engine (ahead of time), the dedicated server,
   the replay verifier and the client with the modified library, and `desktop/package.mjs` and the node
   packers package the result.

The engine is part of the simulation's build id, so a modified build reports its own `simBuild` and plays
with builds that carry the same one.

## FuzzyLogicLibrary: which GPL version

**What is known:**
- The package that ships is `OpenRA-FuzzyLogicLibrary` 1.0.1 on NuGet.
  - Its package metadata declares no licence.
  - It points to `https://github.com/OpenRA/fuzzynet`, which no longer exists.
  - Its author, teinarss, keeps https://github.com/teinarss/fuzzynet. That is a fork of
    https://github.com/kaluzhny/fuzzynet, whose two commits are "Initial commit" and "copy from
    http://sourceforge.net/projects/fuzzynet/".
- Both repositories carry the text of the **GNU GPL version 2** as `LICENSE`.
- The source files carry only "Copyright (C) 2008 Dmitry Kaluzhny". They state no version, and no "or any
  later version".
- OpenRA itself ships this library in its GPL-3.0-or-later releases. Its `AUTHORS` says "released under
  the GNU GPL terms", with no version.

**Why it matters:**
- If the library is **GPL v2 only**, it cannot be combined with GPL v3 code. That would affect OpenRA's
  releases as well as ours.
- If it may be used under **any version**, there is no conflict. GPL v2 section 9 says: "If the Program does
  not specify a version number of this License, you may choose any version ever published by the Free
  Software Foundation."
- Whether a bundled GPL v2 text "specifies a version number" is the open point.

**Options,** for the owner and a legal reviewer:
1. Ask the author (Dmitry Kaluzhny) to confirm "version 2 or any later version", or to license it under
   GPL v3.
2. Follow OpenRA upstream, which distributes it within GPL-3.0-or-later.
3. Replace it with an in-house implementation of the few fuzzy rules the AI uses
   (`AttackOrFleeFuzzy`). That changes the bots' simulation, so it needs a new engine release with a new
   `simBuild`.

**Status:** the legal question stays open as described. The project follows OpenRA upstream (option 2,
decided 26 September 2026); the question to the author was not sent. The library's source and licence
text are published here either way.

## The packages' licence fields

The npm node package names its licence by SPDX id, `GPL-3.0-or-later`, and carries `COPYING`, `AUTHORS`,
`THIRD-PARTY-NOTICES.txt`, the bundled libraries' licences and `RELEASE-MANIFEST.json`. The desktop app's
`package.json` names `GPL-3.0-or-later` as well; its licence texts ship in `resources/legal/`.
