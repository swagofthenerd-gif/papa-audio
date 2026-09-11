'use strict'
// The floating mini-player card. mpv paints into a native window placed over the
// card's reserved video region, so the card position and the mpv rectangle have
// to be computed from one set of numbers — these cover that geometry as pure
// functions (no DOM), plus the corner-snap chooser, the persisted-position
// shape, the page→screen conversion the maths must agree with, and the mini
// seek fraction.
const test = require('node:test')
const assert = require('node:assert')
const {
  MINI, miniVideoDims, miniCardSize, miniCardTopLeft, miniVideoRect,
  nearestCorner, pageRectToScreen, sanitizeMiniPos, seekFractionAt,
} = require('../src/video-player')

// A roomy desktop viewport and a typical music-bar height, so the bottom
// corners have to clear the bar.
const VP = { width: 1600, height: 900 }
const PLAYER_H = 120

test('the video region is 320x180 compact and 480x270 large', () => {
  assert.deepStrictEqual(miniVideoDims('compact'), { w: 320, h: 180 })
  assert.deepStrictEqual(miniVideoDims('large'), { w: 480, h: 270 })
  // An unknown size is never trusted — it degrades to compact, not to NaN.
  assert.deepStrictEqual(miniVideoDims('bogus'), { w: 320, h: 180 })
})

test('the card is the handle plus the video plus the bar height', () => {
  // A drag-handle strip now sits on top of the card, so the card is taller than
  // the video-plus-bar by the handle height. The handle is where a real mouse
  // grabs to move the card (the picture region is a native window the page can't
  // receive events over).
  assert.deepStrictEqual(miniCardSize('compact'), { w: 320, h: MINI.handleH + 180 + MINI.barH })
  assert.deepStrictEqual(miniCardSize('large'), { w: 480, h: MINI.handleH + 270 + MINI.barH })
})

test('each corner places the card inside the viewport with the inset', () => {
  const inset = MINI.inset
  const c = miniCardSize('compact')
  const tl = miniCardTopLeft('tl', 'compact', VP, PLAYER_H)
  assert.deepStrictEqual(tl, { x: inset, y: inset })

  const tr = miniCardTopLeft('tr', 'compact', VP, PLAYER_H)
  assert.strictEqual(tr.y, inset)
  assert.strictEqual(tr.x, VP.width - c.w - inset)

  const bl = miniCardTopLeft('bl', 'compact', VP, PLAYER_H)
  assert.strictEqual(bl.x, inset)
})

test('the bottom corners clear the music player bar', () => {
  const inset = MINI.inset
  const c = miniCardSize('compact')
  const br = miniCardTopLeft('br', 'compact', VP, PLAYER_H)
  // The card bottom sits above the player bar: y + card height <= viewport
  // height minus the bar minus the inset.
  assert.ok(br.y + c.h <= VP.height - PLAYER_H - inset + 1)
  // And a taller bar pushes the card further up than a zero bar would.
  const withBar = miniCardTopLeft('br', 'compact', VP, PLAYER_H).y
  const noBar = miniCardTopLeft('br', 'compact', VP, 0).y
  assert.ok(withBar < noBar, 'a bar present raises the card')
})

test('the mpv rect is the video box offset below the drag handle', () => {
  // The native mpv window must sit BELOW the handle strip, never over it — or the
  // handle would be buried under the picture and undraggable again. So the rect's
  // y is the card top-left plus the handle height; x and the video dimensions are
  // unchanged.
  const tl = miniCardTopLeft('br', 'large', VP, PLAYER_H)
  const rect = miniVideoRect('br', 'large', VP, PLAYER_H)
  assert.deepStrictEqual(rect, { x: tl.x, y: tl.y + MINI.handleH, width: 480, height: 270 })
})

test('the mpv rect never covers the drag handle at any corner or size', () => {
  for (const corner of MINI.corners) {
    for (const size of ['compact', 'large']) {
      const tl = miniCardTopLeft(corner, size, VP, PLAYER_H)
      const rect = miniVideoRect(corner, size, VP, PLAYER_H)
      assert.ok(rect.y >= tl.y + MINI.handleH,
        corner + '/' + size + ': the video starts at or below the handle bottom')
    }
  }
})

test('a card is placed fully on screen even in a tiny viewport', () => {
  // Smaller than the card itself: the placement must not go negative and shove
  // the picture off the top-left edge.
  const tiny = { width: 200, height: 150 }
  for (const corner of MINI.corners) {
    const tl = miniCardTopLeft(corner, 'compact', tiny, 40)
    assert.ok(tl.x >= 0 && tl.y >= 0, corner + ' stays on screen')
  }
})

test('nearestCorner snaps a dropped card to the closest anchor', () => {
  // A card dragged near the top-left should snap there; near the bottom-right,
  // there. The chooser compares card centres, so feed it a top-left near each
  // corner's own anchor.
  const near = (corner) => miniCardTopLeft(corner, 'compact', VP, PLAYER_H)
  assert.strictEqual(nearestCorner(near('tl'), 'compact', VP, PLAYER_H), 'tl')
  assert.strictEqual(nearestCorner(near('tr'), 'compact', VP, PLAYER_H), 'tr')
  assert.strictEqual(nearestCorner(near('bl'), 'compact', VP, PLAYER_H), 'bl')
  assert.strictEqual(nearestCorner(near('br'), 'compact', VP, PLAYER_H), 'br')
})

test('nearestCorner resolves an off-anchor drop to a real corner', () => {
  // Dropped just past the middle toward the bottom-right.
  const dropped = { x: VP.width * 0.7, y: VP.height * 0.7 }
  const corner = nearestCorner(dropped, 'compact', VP, PLAYER_H)
  assert.ok(MINI.corners.indexOf(corner) !== -1)
  assert.strictEqual(corner, 'br')
  // Toward the top-left instead.
  assert.strictEqual(
    nearestCorner({ x: 10, y: 10 }, 'compact', VP, PLAYER_H), 'tl')
})

test('sanitizeMiniPos accepts good values and defaults the rest', () => {
  assert.deepStrictEqual(
    sanitizeMiniPos({ corner: 'tl', size: 'large' }), { corner: 'tl', size: 'large' })
  // A corrupt or partial blob falls back to bottom-right / compact.
  assert.deepStrictEqual(sanitizeMiniPos(null), { corner: 'br', size: 'compact' })
  assert.deepStrictEqual(sanitizeMiniPos({}), { corner: 'br', size: 'compact' })
  assert.deepStrictEqual(
    sanitizeMiniPos({ corner: 'middle', size: 'huge' }), { corner: 'br', size: 'compact' })
  // A good corner but bad size keeps the corner.
  assert.deepStrictEqual(
    sanitizeMiniPos({ corner: 'tr', size: 'huge' }), { corner: 'tr', size: 'compact' })
})

test('pageRectToScreen adds the window origin and scales by zoom', () => {
  // Zoom 1: a straight offset by the window content origin.
  assert.deepStrictEqual(
    pageRectToScreen({ x: 100, y: 50, width: 320, height: 180 }, 1000, 40, 1),
    { x: 1100, y: 90, width: 320, height: 180 })
  // The real app runs at ~0.9128 zoom: every dimension shrinks by that, and the
  // offset is scaled too (a page point sits nearer the origin at <1 zoom).
  const z = 0.9128
  const r = pageRectToScreen({ x: 200, y: 100, width: 480, height: 270 }, 500, 30, z)
  assert.strictEqual(r.x, Math.round(500 + 200 * z))
  assert.strictEqual(r.y, Math.round(30 + 100 * z))
  assert.strictEqual(r.width, Math.round(480 * z))
  assert.strictEqual(r.height, Math.round(270 * z))
  // A missing or absurd zoom is treated as 1 rather than zeroing the picture.
  const safe = pageRectToScreen({ x: 0, y: 0, width: 320, height: 180 }, 0, 0, 0)
  assert.deepStrictEqual(safe, { x: 0, y: 0, width: 320, height: 180 })
})

test('seekFractionAt clamps a pointer to 0..1 across the track', () => {
  // Track from x=100 to x=500 (width 400).
  assert.strictEqual(seekFractionAt(100, 100, 400), 0)
  assert.strictEqual(seekFractionAt(300, 100, 400), 0.5)
  assert.strictEqual(seekFractionAt(500, 100, 400), 1)
  // Past either end is clamped, not extrapolated.
  assert.strictEqual(seekFractionAt(0, 100, 400), 0)
  assert.strictEqual(seekFractionAt(9999, 100, 400), 1)
  // A zero-width track (never measured) is a defined 0, not a divide-by-zero.
  assert.strictEqual(seekFractionAt(300, 100, 0), 0)
})

test('the top corners sit below the title bar, never behind it (V1)', () => {
  // The app title bar is a fixed 44px drag region across the top; a card
  // placed at the bare inset had its handle under it, so a click on the handle
  // moved the window instead of the card.
  const tl = miniCardTopLeft('tl', 'compact', VP, PLAYER_H, 44)
  assert.deepStrictEqual(tl, { x: MINI.inset, y: MINI.inset + 44 })
  assert.strictEqual(miniCardTopLeft('tr', 'compact', VP, PLAYER_H, 44).y, MINI.inset + 44)
  // The bottom corners are unaffected; without a bar the old numbers hold.
  assert.deepStrictEqual(miniCardTopLeft('br', 'compact', VP, PLAYER_H, 44), miniCardTopLeft('br', 'compact', VP, PLAYER_H))
  assert.deepStrictEqual(miniCardTopLeft('tl', 'compact', VP, PLAYER_H, 0), miniCardTopLeft('tl', 'compact', VP, PLAYER_H))
  // The video rect and the corner chooser carry the same inset.
  assert.strictEqual(miniVideoRect('tl', 'compact', VP, PLAYER_H, 44).y, MINI.inset + 44 + MINI.handleH)
  assert.strictEqual(nearestCorner({ x: 30, y: 60 }, 'compact', VP, PLAYER_H, 44), 'tl')
})
