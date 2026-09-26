# Third-party notices

**Redline Wars: Fractured Order** © 2026 Jolyn Studios. Source:
https://github.com/jolynstudios/redlinewars.

## Licensing at a glance
- **GNU GPL v3 or later:** all source code in this repository.
  - The engine is a fork of OpenRA, © The OpenRA Developers and Contributors (`engine/COPYING`,
    `engine/AUTHORS`).
  - Also its WebAssembly port, the dedicated server and multiplayer code, the WebGPU client (`web/`), the
    desktop app (`desktop/`) and the build tools (`tools/`).
  - See `LICENSE` and `NOTICE.md`.
- **Not in this repository, not under the GPL:** the separately licensed art of the official builds, and
  the Redline Wars name, logo and icon (trademarks of Jolyn Studios). See `NOTICE.md`.
- Everything below is third-party material under its own licence. The licence texts that are not
  reproduced here are in `licenses/`.

Redline Wars is endorsed by neither Electronic Arts nor the OpenRA project. No Westwood or EA art, audio,
voices or video are shipped, hosted or committed.

## OpenRA and the libraries it bundles
OpenRA © The OpenRA Developers and Contributors (https://www.openra.net, https://github.com/OpenRA/OpenRA),
free software under the GNU GPL v3 or later. The engine keeps OpenRA's copyright headers. `engine/AUTHORS`
(shipped as `AUTHORS-OpenRA.txt`) lists its contributors.

The libraries below ship as .NET assemblies:
- in the browser and desktop engine (`AppBundle/_framework/*.wasm`, and compiled into `dotnet.native.wasm`);
- in the dedicated server and the ranked replay verifier (`bin-standalone/<rid>/`).

| Library (NuGet package, version) | Licence | Source |
|---|---|---|
| Eluant (OpenRA-Eluant 1.0.22) | MIT | https://github.com/OpenRA/Eluant |
| SharpZipLib 1.4.2 | MIT | https://github.com/icsharpcode/SharpZipLib |
| Mono.Nat 3.0.4 | MIT | https://github.com/mono/Mono.Nat |
| NVorbis 0.10.5 | MIT | https://github.com/NVorbis/NVorbis |
| rix0rrr.BeaconLib 1.0.2 | MIT | https://github.com/rix0rrr/beacon |
| DiscordRichPresence 1.2.1.24 | MIT | https://github.com/Lachee/discord-rpc-csharp |
| Json.NET (Newtonsoft.Json 13.0.1) | MIT | https://github.com/JamesNK/Newtonsoft.Json |
| Pfim 0.11.3 | MIT | https://github.com/nickbabcock/Pfim |
| Linguini (Linguini.Bundle 0.8.1, Linguini.Shared and Linguini.Syntax 0.8.0) | MIT or Apache-2.0 | https://github.com/Ygg01/Linguini |
| StbTrueTypeSharp 1.26.12 | public domain | https://github.com/rds1983/StbSharp |
| MP3Sharp 1.0.5 | GNU LGPL v3 (`licenses/LGPL-3.0.txt`, with the GPL v3 in `LICENSE`) | https://github.com/Nihlus/MP3Sharp; the NuGet package https://www.nuget.org/packages/MP3Sharp/1.0.5 carries its source under `src/` |
| TagLib# (TagLibSharp 2.3.0) | GNU LGPL v2.1 (`licenses/LGPL-2.1.txt`) | https://github.com/mono/taglib-sharp/tree/TaglibSharp-2.3.0.0 |
| FuzzyLogicLibrary (OpenRA-FuzzyLogicLibrary 1.0.1): "fuzzynet", © 2008 Dmitry Kaluzhny | GNU GPL; see below | https://github.com/teinarss/fuzzynet, a copy of https://github.com/kaluzhny/fuzzynet (originally https://sourceforge.net/projects/fuzzynet/) |

Also shipped:
- Lua 5.1 (MIT, © Lua.org, PUC-Rio), as the server's native `lua51` library.
- The Microsoft .NET runtime and libraries, including the WebAssembly runtime (MIT, © .NET Foundation and
  Contributors). The ICU data is under the Unicode licence.

OpenRA's `AUTHORS` also names SDL2-CS and OpenAL-CS (zlib) and FreeType (FreeType License), which are used by
OpenRA's native desktop client. Redline Wars does not ship them.

**The LGPL libraries** (MP3Sharp, TagLib#) are used unmodified, as separate assemblies. In the browser
engine they are also compiled ahead of time into `dotnet.native.wasm`. This repository is the complete
corresponding source of the program that uses them, and `tools/build.mjs` rebuilds it. That lets you relink
the program with a modified version of either library: change the package reference, or replace the
assembly, and rebuild.

**FuzzyLogicLibrary** is licensed under the GNU GPL. Its source repository carries the text of GPL
version 2, and its source files state no version and no "or any later version".
[compliance/DEPENDENCIES.md](compliance/DEPENDENCIES.md) records what is known and the open question of
which versions apply. The GPL v2 text is in `licenses/GPL-2.0.txt`.

## Maps
The skirmish maps from OpenRA's Red Alert mod are by their authors: PizzaAtomica, Nuke'm Bro., Lad,
kazu., SoScared, Janitor, FRenzy, hamb, Chris Forbes, netnazgul, Seru, Kyrylo Silin, Jopani Kansaro,
Green Giant, sith_wampa, morkel, james.bong, eskimo, Wippie, Trump, The Echo of Damnation, Super
Newbie, Sprog, Scott_NZ, MicroBit, Madness, Comrade Tiki, Christian, CRLF, Blunt, A. Blunt (Luftwaffe
Edit), Blarget2, Blackened and 010010.

## Art of the official builds (not in this repository)
The official builds' models, textures and effects are built by the private art pipeline. Where a bake
starts from an external scan, texture or model, that file is recorded in `art/sources.lock.json` with its
URL, author, licence and sha256. Only CC0 and CC-BY 4.0 sources are accepted. The list below is generated
from that lock:

<!-- sources:begin -->
- Concrete 034 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Concrete034_1K-JPG.zip, licence https://docs.ambientcg.com/license/, used for industrial material library: building concrete and first textured-ground witness.
- Grass 004 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Grass004_2K-JPG.zip, licence https://docs.ambientcg.com/license/, used for phase-1 lush grass ground; procedural PBR source, not photogrammetry.
- Ground 037 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Ground037_2K-JPG.zip, licence https://docs.ambientcg.com/license/, used for phase-1 scanned mossy forest ground; original Blender terrain material graph.
- Ground 054 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Ground054_2K-JPG.zip, licence https://docs.ambientcg.com/license/, used for phase-1 scanned dirt and sandy mud; original Blender terrain material graph.
- Metal 032 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Metal032_1K-JPG.zip, licence https://docs.ambientcg.com/license/, used for industrial material library: metal surface maps with original painted-steel treatment for phase-0 tank.
- Metal 038 by ambientCG, CC0-1.0, https://ambientcg.com/get?file=Metal038_1K-JPG.zip, licence https://docs.ambientcg.com/license/, used for scratched steel detail beneath original painted-steel treatment; replaces too-smooth Metal032 in phase-0 library.
- Human hm08 anatomical base mesh by MakeHuman Community, CC0-1.0, https://raw.githubusercontent.com/makehumancommunity/mpfb2/437dd513888a92399d1d3200d2e80859fae55abc/src/mpfb/data/3dobjs/base.obj, licence https://github.com/makehumancommunity/mpfb2/blob/437dd513888a92399d1d3200d2e80859fae55abc/LICENSE.md, used for phase-3 anatomical infantry source; core asset data only, original clothing and presentation rig adaptation.
- Game-engine humanoid rig by MakeHuman Community, CC0-1.0, https://raw.githubusercontent.com/makehumancommunity/mpfb2/437dd513888a92399d1d3200d2e80859fae55abc/src/mpfb/data/rigs/standard/rig.game_engine.json, licence https://github.com/makehumancommunity/mpfb2/blob/437dd513888a92399d1d3200d2e80859fae55abc/LICENSE.md, used for phase-3 anatomical infantry source; core asset data only, original clothing and presentation rig adaptation.
- Authored humanoid skin weights by MakeHuman Community, CC0-1.0, https://raw.githubusercontent.com/makehumancommunity/mpfb2/437dd513888a92399d1d3200d2e80859fae55abc/src/mpfb/data/rigs/standard/weights.game_engine.json, licence https://github.com/makehumancommunity/mpfb2/blob/437dd513888a92399d1d3200d2e80859fae55abc/LICENSE.md, used for phase-3 anatomical infantry source; core asset data only, original clothing and presentation rig adaptation.
- Universal Base Characters [Standard] (Superhero male and female base characters) by Quaternius, CC0-1.0, https://quaternius.itch.io/universal-base-characters, licence https://creativecommons.org/publicdomain/zero/1.0/, used for phase-3 troop base mesh replacement candidate; evaluation study and bake source, original clothing and presentation rig adaptation.
<!-- sources:end -->

Supplied inputs (`art/supplied-inputs.lock.json`, which records each input's rights and their evidence):
- The soldiers (`swat-female-commando`) build on "Female S.W.A.T Tactical Soldier" by
  pathumtharaka1998 (https://www.cgtrader.com/free-3d-models/military/military-character/female-swat-soldier),
  used under CGTrader's Royalty Free License: use in our own product, modified, commercial use allowed;
  the model file itself is not redistributed, and it is not used to train or fine-tune AI models.
  Modified for this game: its body became the shared soldier base and the first Riki, refitted to the
  game's rig and retextured, with heads and kit from the civilians' base model.
- The civilians build on Jolyn Studios' own character model (`military-game-character`), made in
  Blender. Riki was modelled by Jolyn Studios with Meshy; the dog is Jolyn Studios' own sculpt.
- None of these models is in this repository; the art packs that carry them are separately licensed.

The music was made with Suno. The announcer voices are Cartesia text-to-speech. The character voices and
sound effects are ElevenLabs text-to-speech and sound generation. None of it is in this repository; the
stand-ins that `tools/fallback-art.mjs` writes are silence.

## Fonts

The pre-match screens (loader, setup, account) use two typefaces under the SIL Open Font License 1.1.
They come from the `@fontsource-variable` dev dependencies at build time, are built into the bundle and
are served from our own origin — no font CDN is contacted during play. Their licences ship next to them
in the build (`web/public/licenses/`).

- Archivo — Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo), SIL OFL 1.1.
- Martian Mono — Copyright 2020 The Martian Mono Project Authors (https://github.com/evilmartians/mono), SIL OFL 1.1.

## Code adapted from third parties
The AgX tone-mapping constants in `web/src/render/shaders.ts` are transcribed from three.js (MIT,
© 2010–2026 three.js authors).

## Desktop app and hosting node
- Electron 44 (MIT, © Electron contributors, © GitHub Inc.), with Chromium (BSD-style licences; the full
  list ships with the app as `LICENSES.chromium.html`, and Electron's own licence as `LICENSE.electron.txt`).
  The installers are built with electron-builder (MIT): NSIS on Windows (zlib/libpng licence) and the
  AppImage runtime on Linux (MIT).
- ws 8.21.3 (MIT, © Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors), the node's only
  runtime dependency.
- Node.js v24.21.0 (MIT, © OpenJS Foundation and Node.js contributors), bundled in the Windows node zip. Its
  licence, which lists its own bundled components, ships as `runtime/node-LICENSE.txt`.

## Trademarks
Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. EA has not endorsed and does not
support this product. Real product names in the field guide are used descriptively.

## The MIT License
The MIT-licensed components named above are used under these terms (each with its own copyright
line, as listed):

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
