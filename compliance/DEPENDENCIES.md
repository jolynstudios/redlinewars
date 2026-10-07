# Dependency and licensing research

This record preserves the substantive dependency research from the earlier public export and scopes
it to the current public source edition. It is not a claim that the separate production game has
been rebuilt or re-audited. Actual checks on this edition belong in [RELEASES.md](RELEASES.md).
Notices and component source references are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Source-edition dependencies

| Build target | Components to account for |
|---|---|
| Browser AppBundle | OpenRA and its referenced .NET libraries; .NET WebAssembly runtime and its Unicode/ICU data; WebGPU client |
| Electron wrapper | The same AppBundle, Electron and its bundled Chromium/runtime components |
| Dedicated server and replay verifier | OpenRA libraries selected by each project; self-contained .NET runtime and native Lua when bundled |
| Hosting node | Node.js, ws, the server and generated mod; a runtime is included only where the selected package bundles one |

Freehop and the production font packages are excluded. The public UI uses system fonts. No production
art, recorded audio or companion application is supplied.

## Notices and source requirements

| Component | Licence | Retained material and rebuild route |
|---|---|---|
| OpenRA and project modifications | GPL-3.0-or-later | `LICENSE`, `engine/COPYING`, copyright headers, `engine/AUTHORS`, source and build scripts for this edition |
| MP3Sharp 1.0.5 | LGPL-3.0 | LGPL v3 and GPL texts; source in its NuGet package under `src/` and at https://github.com/Nihlus/MP3Sharp; replace and rebuild as below |
| TagLibSharp 2.3.0 | LGPL-2.1-only | LGPL v2.1 text; source at https://github.com/mono/taglib-sharp/tree/TaglibSharp-2.3.0.0; replace and rebuild as below |
| OpenRA-FuzzyLogicLibrary 1.0.1 | GNU GPL, version ambiguity recorded below | GPL v2 text and source references; prior owner decision retained |
| .NET, Lua, ws and other MIT libraries | MIT and component-specific notices | Preserve copyright and licence notices, including the runtime's complete third-party notice file |
| Electron and bundled Chromium components | MIT, BSD-style and component-specific licences | Preserve Electron's licence and `LICENSES.chromium.html`; inspect the actual packaged platform dependencies |

An artifact distribution needs notices and source arrangements appropriate to what that artifact
contains. A source snapshot's upstream provenance hash does not establish source correspondence for
a different production binary. The source-edition manifests and verification tools identify this
edition's own source and artifacts.

## Rebuilding with a modified LGPL library

MP3Sharp and TagLibSharp are NuGet package references in the engine's `OpenRA.Mods.Common` projects.
For a modified version:

1. Build it as a NuGet package in a local feed (`dotnet pack`, then `dotnet nuget add source <folder>`),
   or replace the `<PackageReference>` with a `<Reference>` to the modified assembly.
2. Give a replacement package a new version number and update the reference. A package already in
   the NuGet cache under the old version can otherwise be reused without warning.
3. Run `node tools/build.mjs` and any required `--standalone <rid>` builds. Package that newly built
   AppBundle or server with the included packager.

The earlier compliance work recorded a successful modified-MP3Sharp rebuild in an isolated fixture.
That is historical supporting evidence; it does not substitute for checking a modified build of this
edition. Engine changes affect the simulation build id, and connected game clients must use matching
simulation builds.

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

**Options considered in the prior review:**

1. Ask the author (Dmitry Kaluzhny) to confirm "version 2 or any later version", or to license it under
   GPL v3.
2. Follow OpenRA upstream, which distributes it within GPL-3.0-or-later.
3. Replace it with an in-house implementation of the few fuzzy rules the AI uses
   (`AttackOrFleeFuzzy`). That changes the bots' simulation, so it needs a new engine release with a new
   `simBuild`.

**Status:** closed. The owner decided — 26 September 2026, re-confirmed 28 September 2026 ("OpenRA has
shipped this library for 15 years; we follow the same rule") — to follow OpenRA upstream (option 2).
The question to the author will not be sent. The "What is known" facts above stay as the record of what
the sources state; they no longer track an open decision. The source references and GPL v2 text are
retained. This is the recorded owner decision, not a new clarification from the library author or a
legal opinion.

## Preserved review findings

The earlier review added the .NET runtime's own third-party notice file to composition and documented
LGPL replacement/rebuild steps. It also identified platform-specific desktop notice review as a
follow-up: FFmpeg, Linux AppImage libraries, NSIS plug-ins and helper executables, Electron's
SwiftShader/Vulkan/DXC/d3dcompiler components, and Mantle/ReactiveObjC where bundled. Electron's
`LICENSES.chromium.html` covers many components, but the exact packaged artifact determines the list.
No previous desktop validation result is asserted for this edition.

Asset rights and origins remain recorded in `art/sources.lock.json`, `art/supplied-inputs.lock.json`
and `art/content-provenance.json`. Those records concern absent production assets. The public-sample
asset check must validate the generated fallback inputs and must not treat earlier owner review as
approval of new or changed asset bytes.

## Package metadata

Project package metadata uses `GPL-3.0-or-later`. Packaged outputs must preserve the GPL text,
OpenRA contributor attribution and applicable third-party notices. A version or source-edition label
does not replace the component-specific terms above.
