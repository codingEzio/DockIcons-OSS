# Tool dependencies

- Deno 2.x runs the CLI, checks, JSON manifests and SHA-256. Install separately.
- App operations and `add` require macOS plus Xcode Command Line Tools. AppKit, Foundation and
  UniformTypeIdentifiers are Apple OS/SDK frameworks; xcrun/swiftc, sips/iconutil, xattr and
  codesign are system/developer tools. No download runs during normal commands.
- Optional fzf enables the project-owned `dock-icon` chooser. The external Kit launcher is not
  included. The chooser requires at least one registered icon.
- No original or third-party raster artwork, third-party fonts, npm modules, AI service, API keys,
  account, background service or HTTP server are bundled. The native test embeds two tiny synthetic
  PNGs with no metadata. The 13 documentation SVGs are described below. Users supply their own
  rights-cleared square RGBA PNG inputs; `prompt` only prints the generic style configuration.
- Root-owned App metadata writes need a separately installed compatible administrator helper. Set
  `X_DOCKICONS_ADMIN_HELPER` to its executable path; there is no default. The helper must accept
  `/bin/sh` and a script path as arguments, and execute that script with administrator privileges.
  An unset or unavailable helper fails visibly; the existing backup is retained. The tool stores no
  password. The user must review and trust their chosen helper.
- Full MPL-2.0 is in LICENSE. The 12 original workflow SVGs are MPL-2.0 and reference viewer fonts
  only. The new mark alone uses CC BY 4.0; see LICENSE-DOC-ARTWORK.md. No old icon or
  derived-preview license is granted here.

The private owner checkout retains its original collection and metadata. They are neither
dependencies nor assets of this source candidate. Existing AppKit acceptance using the old assets is
historical evidence only; no new installed App, physical reboot or theme acceptance is claimed for
this candidate.
