# Notice

**Redline Wars: Fractured Order**
Copyright © 2026 Jolyn Studios.

**OpenRA**
Copyright © The OpenRA Developers and Contributors ([engine/AUTHORS](engine/AUTHORS)).

## Licence

The source code in this repository is free software. This covers `engine/`, `web/`, `desktop/`, `tools/`
and the build files at its root. You can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

The engine is a fork of OpenRA. It keeps OpenRA's copyright headers and licence ([engine/COPYING](engine/COPYING)).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License
([LICENSE](LICENSE)) for more details.

Third-party components keep their own licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with the
licence texts in [licenses/](licenses/).

## Trademarks and brand

"Redline Wars", "Redline Wars: Fractured Order", the Redline Wars logo and icon, and "Jolyn Studios" are
trademarks of Jolyn Studios.

As section 7(e) of the GNU GPL v3 permits, no rights are granted under trademark law for their use. A modified
version must not present itself as Redline Wars or as an official build. As section 7(c) permits, it must be
marked as changed from the original.

The logo mark appears in `web/index.html` and `web/public/favicon.svg`, so the client builds unchanged. The
desktop icons and backgrounds are not in this repository.

Command & Conquer and Red Alert are trademarks of Electronic Arts Inc. EA has not endorsed and does not
support this product.

## Art that is not in this repository

The official builds carry separately licensed art that is not part of this repository and not licensed
under the GPL:
- the Blender-built models, textures and landmark packs;
- the music, voices and sound effects;
- the cinematics;
- the brand icons and backgrounds.

`tools/fallback-art.mjs` writes neutral stand-ins, and those stand-ins are part of this repository's
licence. The provenance records of the art (`art/sources.lock.json`, `art/supplied-inputs.lock.json`) are
included because the client build reads them.
