# Local tools-only candidate

The owner selected tools, generic documentation and the approved new documentation mark only.
`public-files.json` is the explicit selection; its `sources` map uses reviewed public variants for
the empty catalog, reference-free style, dependency notes and standalone check configuration. The
private catalog, all 82 original PNG/ICNS files, six extracted preview PNGs, their receipt/gallery,
old reference workflow documents, original metadata/C2PA and old packets/history stay unchanged
outside this candidate. The 12 original workflow SVGs contain only generic vector geometry and text,
with viewer font references and no embedded images.

`deno task public:prepare` runs the owning source checks, exporter regression and explicit source
selection, then creates `Local/public-candidates/<seal>`. Every selected source path, byte hash and
executable mode is recorded in `candidate-receipt.json`; reuse checks exact
files/directories/modes/receipt and never overwrites mismatches. Unsafe mapped paths, symlinks,
home/credential-shaped text, old asset/preview paths, raster files and embedded SVG image references
are rejected. Tools-only scope also requires the empty starter catalog and no style reference
images. These are selected-payload checks, not a universal secret audit.

The candidate can check, lint and typecheck its sources and run its tests without the old
collection. A disposable signed App and synthetic image were used to verify registration, apply and
restore. Installed Apps, live Dock display and reboot were not tested. Follow README to register an
input you may use. The old asset-dependent macOS fixture and companion generation skill are not
shipped.

The new documentation mark alone is CC BY 4.0 with codingEzio attribution; see
LICENSE-DOC-ARTWORK.md. Code and generic diagrams remain MPL-2.0. This selection does not clear
excluded brand artwork or remove its metadata. The approved SVG is excluded from formatting solely
to retain its exact approved bytes.

Source candidates contain no Git directory. The reviewed public Git history uses the codingEzio
public identity and the selected files only; private original histories and earlier review trees are
preserved. The owner approved this tools-only source; repository visibility is managed separately.
The local release check validates this selection; it does not authorize other source, artwork, or
release operations. No counterpart/physical-device or reboot claim is made.
