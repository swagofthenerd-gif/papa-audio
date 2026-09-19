# Soulseek Explorer — design deliverable

`explorer.css` + `mock.html` (open over HTTP, e.g. `python3 -m http.server --directory ~/flac-player`, then `/design/slsk-explorer/mock.html`; `?only=<state>&theme=light` renders one state). No repo file is touched; everything is scoped under `.slsk-explore`, every class is `slx-`.

## Classes per component
| Component | Classes |
|---|---|
| Root / layout | `.slsk-explore` (+ `.slx-side-collapsed`, `.slx-side-open`, `.slx-selecting`), `.slx-head`, `.slx-side`, `.slx-filters`, `.slx-body`, `.slx-body-inner` |
| Header | `.slx-eyebrow`, `.slx-head-title`, `.slx-peer` (+`em`), `.slx-presence.is-online/.is-away`, `.slx-stats`, `.slx-stat`, `.slx-visit`, `.slx-new-count`, `.slx-head-tools`, `.slx-viewtoggle` (`button[aria-pressed]`), `.slx-icon-btn` |
| Sidebar | `.slx-side-sec`, `.slx-side-h`, `.slx-facts` (dl), `.slx-common`, `.slx-tree` (`button[style=--depth][aria-current]`), `.slx-tree-glyph/-name/-n`, `.slx-side-actions`, `.slx-btn` (+`-primary`, `-ghost`, `[aria-pressed]`) |
| Filter bar | `.slx-chipgroup`, `.slx-chip[aria-pressed][data-tier]`, `.slx-n`, `.slx-filters-right`, `.slx-search` (label>input), `.slx-sort`, `.slx-count` |
| Rails | `.slx-rail[data-tier]`, `.slx-rail-head`, `.slx-rail-title`, `.slx-rail-sub`, `.slx-rail-seeall`, `.slx-rail-track`, `.slx-grid-sec`, `.slx-grid` |
| Card | `.slx-card[data-tier]` (+`.is-selected`, `.is-inlib`), `.slx-card-art`, `.slx-art-fb`, `.slx-label`, `.slx-inlib`, `.slx-sel` (label>checkbox), `.slx-card-title`, `.slx-card-artist` > `.slx-year`, `.slx-q` > `.slx-q-spec`, `.slx-upgrade` > `.slx-yours/.slx-arrow/.slx-theirs`, `.slx-countwarn`, `.slx-card-meta`, `.slx-acts` > `.slx-act[data-act=preview|play|download|replace|wish]`, `.slx-progress` |
| Batch bar | `.slx-batchbar[hidden]`, `.slx-batch-n` > `b.slx-batch-count.slx-tick`, `.slx-batch-sub`, `.slx-btn[data-act=replace|clear]` |
| Compare drawer | `.slx-drawer.is-open`, `.slx-scrim.is-open`, `.slx-cmp-head/-title/-artist/-close`, `.slx-cmp-sides` > `.slx-cmp-side[data-tier]` > `.slx-cmp-side-h`, `.slx-cmp-spec`, `.slx-verdict.is-mixed/.is-worse`, `.slx-cmp-body`, `.slx-cmp-table` (`td.slx-n`, `td.slx-t`, `tr.is-missing`), `.slx-pair` > `.slx-mine`, `.slx-v.is-better/.is-same/.is-worse/.is-missing`, `.slx-cmp-foot` > `.slx-reason` |
| States | `.slx-skel`, `.slx-skel-text`, `.slx-card.slx-skel-card`, `.slx-state.is-error`, `.slx-state-sleeve/-title/-sub/-acts`; `.dry-run-pill` compatibility rule |

## Design decisions (the short version)
1. **One idea: the record label.** Every quality tier is a label colour — gold hi-res, plum surround, green lossless, stone lossy — as a spindle-hole disc on the art, in the `.slx-q` badge, on active chips, the rail spine and the compare header. Colour means only "what the sound is made of"; nothing else is coloured.
2. **Typography-led.** Peer name, rail titles, verdict count and state titles are Newsreader (already bundled); everything you *read* is Poppins. No icon system beyond the app's existing glyphs.
3. **Rails are shelves** — a 4×24 px sleeve-edge spine in the tier colour, track fades at the right edge, snap-scroll.
4. **Play is always visible** (`opacity:.85`, the CLAUDE.md rule); Preview/Download/Replace/Wishlist reveal on hover/focus-within with a 15 ms stagger so it reads as one gesture. Checkbox reveals the same way and sticks when checked or when any selection exists (`.slx-selecting`).
5. **Replace is amber everywhere** because it overwrites; the count-mismatch warning is a pill on the card and a spelled-out reason next to the disabled button in the drawer.
6. **Compare drawer shows two truths, one verdict** — paired cells (theirs over yours), a verdict glyph per row, and a single honest sentence with a coloured left rule (green/amber/red). Closed, it is `visibility:hidden`: out of the tab order, no off-canvas width.
7. **Motion budget:** card lift 160 ms / 3 px, drawer 200 ms, batch bar 180 ms, count tick 180 ms, rail rise 220 ms staggered 30 ms. `prefers-reduced-motion` collapses every transition/animation to 1 ms and kills the shimmer.
8. **Layout:** two-column grid, sidebar collapses at ≤1060 px (or via `.slx-side-collapsed`); body capped at 1760 px and centred at 2560; grid `auto-fill minmax(168px,1fr)`; no page-level horizontal scroll at 1024×640 or 2560×1440 (measured: `scrollWidth === innerWidth`).
9. **Tokens** added only under `.slsk-explore` / `body.theme-light .slsk-explore`; app tokens (`--bg*`, `--accent`, `--*-ink`, `--hairline`) are read, never redefined. Two new inks were needed because the app's `--text3` (#777) fails 4.5:1 on #080808 (4.46) and its light `--text3` fails on `--bg3` (4.4).
10. **Focus:** 2 px accent ring, offset 2, on every button/chip/card/row/input; roving arrow-key focus and Space-to-select are shown in the mock script.

## Measured contrast (WCAG, computed with the relative-luminance formula; tints alpha-blended onto their real ground first)
Dark: ink #f0f0f0 on bg/bg3/bg4/bg5 = 17.6 / 15.6 / 14.1 / 12.6 · ink-2 #a8a8a8 on bg/bg3/bg4/bg5 = 8.4 / 7.5 / 6.8 / 6.0 · ink-3 #8f8f8f on bg/bg2/bg3 = 6.2 / 5.9 / 5.5 · lossless #1db954 on bg3 6.9, on its tint 5.5 · hi-res #e6bd5c on bg3 10.0, on tint 7.5 · surround #c9a9ff on bg3 9.0, on tint 6.9 · lossy #a8a8a8 on tint 6.0 · amber-ink on tint 6.6 (on bg4 tint 6.0) · error-ink on tint 5.6 · #000 on accent 8.1 · chip active 6.4 · dry-run #ffb347 on bg 11.2.
Light: ink #201d18 on bg/bg3/bg4/bg5 = 15.3 / 12.8 / 11.5 / 10.2 · ink-2 #5c564c on bg/bg3/bg4 = 6.6 / 5.5 / 5.0 (fails on bg5 at 4.43 → never used there) · ink-3 #625b4f on bg/bg2/bg3 = 6.1 / 5.6 / 5.1 · lossless #0d5c2b on bg3 6.2, on tint 5.5 · hi-res #7a5000 on bg3 5.4, on tint(.12) 4.95 · surround #573a96 on bg3 6.5, on tint 5.4 · lossy on tint 4.9 · amber-ink on bg4 4.85; on the raised amber tint `--warn-ink` #664200 5.6 (amber-ink fails there at 4.37 → swapped) · error-ink on tint 5.0 · #000 on accent 8.1 · dry-run pill re-inked #7a5000 on bg 6.4.
Lowest pair anywhere: 4.85 (light amber-ink on bg4). Everything else ≥ 4.9.
