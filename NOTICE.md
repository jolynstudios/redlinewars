# Notice

**Redline Wars — public source edition**
Copyright © 2026 Jolyn Studios.

**OpenRA**
Copyright © The OpenRA Developers and Contributors ([engine/AUTHORS](engine/AUTHORS)).

## Modifications and scope

Public source edition, modified 7 October 2026. This edition restores the engine, WebAssembly host,
WebGPU renderer, build tooling and licensing documentation, and supplies a minimal interface and
generated stand-in assets. Its included and excluded features are documented in [README.md](README.md).
It is distinct from the separately distributed production client.

The upstream engine's copyright headers, attribution and licence notices are preserved. The public
edition's source provenance and export adaptations are recorded in [RELEASE-SOURCE.json](RELEASE-SOURCE.json).

## Licence

The project source code in `engine/`, `web/`, `desktop/`, `tools/` and the root build files is free
software. You can redistribute it and/or modify it under the terms of the GNU General Public License
as published by the Free Software Foundation, either version 3 of the License, or (at your option)
any later version. Third-party components retain their own applicable licences and notices.

The engine is a fork of OpenRA and preserves [engine/COPYING](engine/COPYING).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License ([LICENSE](LICENSE)) for more details.

Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with additional
licence texts in [licenses/](licenses/) and [engine/licenses/](engine/licenses/).

## Trademarks

"Redline Wars", "Redline Wars: Fractured Order", the Redline Wars logo and icon, and "Jolyn Studios"
are trademarks of Jolyn Studios. Under GNU GPL v3 section 7(e), no rights under trademark law are
granted for their use. Modified distributions must not misrepresent themselves as official builds
and must be clearly marked as modified, as permitted by section 7(c).

Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. EA has not endorsed and does
not support this product. The OpenRA project does not endorse this edition.

## Stand-in assets and provenance

Production models, textures, music, recorded voices, sound-effect banks, cinematics, logos and
backgrounds are not included. This repository grants no rights to those absent assets.

`tools/fallback-art.mjs` generates neutral stand-ins covered by this repository's GPL licence.
Procedural rendering and synthetic audio code are also included under that licence.

The records in `art/sources.lock.json`, `art/supplied-inputs.lock.json` and `art/content-provenance.json`
preserve asset provenance and build-input research. A provenance record does not include the asset
it describes or grant rights beyond its stated licence. Public-sample validation checks the generated
stand-ins separately from the production asset evidence.
