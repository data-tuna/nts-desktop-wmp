# nts-desktop-wmp

NTS Radio Bootleg Media Player: an unofficial Windows Media Player-style
desktop player for [NTS Radio](https://www.nts.live/), in progress. The plan:
it opens straight into NTS 1, switches to NTS 2 with one click, and wears a
classic Windows Media Player skin, a different one each time it starts. It is
the sister app to
[nts-desktop-winamp](https://github.com/data-tuna/nts-desktop-winamp).

**This is a fan project. It is not made, endorsed or supported by NTS.** If
you listen a lot, support the station directly:
[nts.live/supporters](https://www.nts.live/supporters).

Status: a scaffold. `npm run tauri dev` opens an empty window. Nothing plays
yet. Windows comes first, then macOS.

## Credits

- The skins are the work of their original authors, many of them Microsoft's
  own WMP designers and many of them fans. The app will download them one at a
  time from the
  [Windows Media Player Skins Archive](https://archive.org/details/windowsmediaplayerskinsarchive)
  on archive.org and cache them on your machine. None are included in this
  repository or the installer.
- [Tauri](https://tauri.app/) is the desktop shell.
- Streams come from NTS via `streams.radiomast.io`.

## Development

You need Windows 10 or 11 with:

1. **Node.js** 22.18 or newer (the tests import TypeScript directly).
2. **Microsoft C++ Build Tools**: install
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   and tick "Desktop development with C++".
3. **WebView2**: already present on Windows 11 and current Windows 10.
4. **Rust** with the MSVC toolchain:

   ```powershell
   winget install --id Rustlang.Rustup
   rustup default stable-msvc
   ```

Then:

```powershell
npm install
npm run tauri dev
```

`AGENTS.md` has the other commands and the project's rules.

## Licence

MIT. See [LICENSE](LICENSE).
