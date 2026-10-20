# Kumiko app icon

The app icon is the asanoha (hemp-leaf) kumiko pattern: a hexagon of joined
wooden members, drawn in hinoki wood on a near-black tile.

| Token | Value | Use |
| --- | --- | --- |
| Tile | `#0B0D10` | Icon background |
| Wood | `#D9B98C` | Pattern lines; also the brand accent for the logo mark |

## Files

| File | What it is | Where it goes |
| --- | --- | --- |
| `macos/icon.icns` | macOS app icon, Apple grid (824 px body on a 1024 canvas, transparent margin), 16–1024 px | macOS bundle icon |
| `macos/icon-macos-1024.png` | Same, as a 1024 PNG | Dock icon in development (`app.dock.setIcon`) |
| `macos/icon-macos.svg` | Source of the two above | Editing only |
| `icon.ico` | Windows icon, 16, 24, 32, 48, 64, 128, 256 px | Windows exe and installer |
| `png/NxN.png` | Full-bleed rounded tile, 16 to 1024 px | Linux icons, `BrowserWindow` icon on Windows/Linux, favicons |
| `icon.svg` | Full-bleed tile, regular strokes (48 px and up) | Favicon (`<link rel="icon">`), anywhere an SVG app icon is wanted |
| `icon-small.svg` | Full-bleed tile, heavy strokes (32 px and below) | Small favicons; the 16–32 px PNGs come from this |
| `logo-mark.svg` | The pattern alone, no tile, `stroke="currentColor"` | In-app header logo |
| `preview.png` | Every size on dark and light | Reference only, not shipped |

Sizes 32 px and below use heavier strokes on purpose: the regular
weights blur together at small sizes. Don't regenerate small PNGs by
downscaling the 1024 one.

## Integrating into the app

1. Copy this folder into the repo as `apps/desktop/assets/icon/`.

2. **Packaging.** Point the packager at the platform files.

   electron-builder (`electron-builder.yml` or `package.json` → `build`):

   ```yaml
   mac:
     icon: assets/icon/macos/icon.icns
   win:
     icon: assets/icon/icon.ico
   linux:
     icon: assets/icon/png   # folder of NxN.png files
   ```

   Electron Forge (`forge.config.js`): `packagerConfig.icon: 'assets/icon/icon'`
   picks `.icns` or `.ico` by platform, so copy `macos/icon.icns` next to
   `icon.ico` as `assets/icon/icon.icns` if you use Forge.

3. **Window icon at runtime.** Windows and Linux take the window icon from
   `BrowserWindow`; macOS uses the bundle icon and ignores this option.

   ```ts
   new BrowserWindow({
     icon: path.join(__dirname, '../assets/icon/png/512x512.png'),
     // ...
   });
   ```

   In development on macOS, the unpackaged app shows Electron's icon in
   the Dock. Set it explicitly:

   ```ts
   if (process.platform === 'darwin' && !app.isPackaged) {
     app.dock.setIcon(path.join(__dirname, '../assets/icon/macos/icon-macos-1024.png'));
   }
   ```

4. **Favicon** in the web UI's `index.html` (copy the files into the web
   package's public folder):

   ```html
   <link rel="icon" type="image/svg+xml" href="/icon.svg">
   <link rel="icon" type="image/png" sizes="32x32" href="/png/32x32.png">
   ```

5. **Header logo.** Replace the current logo in the app header with
   `logo-mark.svg`, inlined as a React component so it takes the text
   colour. Render it at 24–28 px, coloured with the wood accent
   (`color: #D9B98C`), next to the app name. Inline the SVG markup rather
   than using `<img>`, since an `<img>` can't inherit `currentColor`.
   Mark it `aria-hidden="true"` when the app name is shown beside it.

## Regenerating

`build.py` produces every file above from the geometry in the script:

```sh
pip install cairosvg pillow
python3 build.py <output-dir>
```

Change the colours or stroke weights there, not in the generated files.
