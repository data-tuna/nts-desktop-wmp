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

Status: in progress. The app opens on NTS 1 in a
random skin from the archive, one of the 59 the engine draws well so far.
Right-click the skin to pick another; the app keeps your pick. The tray icon
plays, stops and switches channels, and opens the current show's page on
nts.live, where you can follow or save it. The media keys work, and only one copy
runs at a time. The window opens where you left it. Without a
network it wears Bootleg House, the one skin drawn for this project.
Windows comes first, then macOS.

## Install (Windows)

Download `NTS.Radio.Bootleg.Media.Player_<version>_x64-setup.exe` from the
latest [release](https://github.com/data-tuna/nts-desktop-wmp/releases/latest)
and run it. It installs for your user only, needs no administrator rights,
and adds a Start menu and a desktop shortcut.

Windows SmartScreen will warn you. The installer is not code-signed, so
Windows shows "Windows protected your PC": click **More info**, then **Run
anyway**. Your browser may also flag the download as uncommon; keep it.

The app updates itself. Each time it starts, it checks GitHub for a newer
release; if there is one, it installs it and restarts, which interrupts the
stream for a few seconds. Updates are signed, and the app refuses one whose
signature does not match.

Uninstall from Settings > Apps. Downloaded skins stay in
`%LOCALAPPDATA%\com.datatuna.ntswmp`; delete that folder to remove them.

## Credits

- The skins are the work of their original authors, many of them Microsoft's
  own WMP designers and many of them fans. The app downloads them one at a
  time from the
  [Windows Media Player Skins Archive](https://archive.org/details/windowsmediaplayerskinsarchive)
  on archive.org and caches them on your machine. None are included in this
  repository or the installer. The one skin that ships, Bootleg House
  (`skins/house/`), was drawn for this project.
- [Tauri](https://tauri.app/) is the desktop shell.
- The Milkdrop visualisation is [Butterchurn](https://github.com/jberg/butterchurn)
  by Jordan Berg (MIT), with the 29 presets of its
  [minimal pack](https://github.com/jberg/butterchurn-presets). Each preset
  is the work of the MilkDrop authors its name credits: Geiss, Flexi,
  Martin, Rovastar, Unchained, Zylot and others.
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
