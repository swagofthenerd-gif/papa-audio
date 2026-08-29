'use strict'
// Daily mixes: group the library by how it sounds, then name each group after
// the artists in it. Naming from artists rather than genre is deliberate --
// 37% of this library's surround albums have no genre tag at all, and those
// that do nearly all say "Progressive Rock".

const { FEATURE_KEYS, distance, buildNormaliser, normalise } = require('./audio-features')

const MAX_ITERATIONS = 25

function meanVector(vectors) {
  const out = {}
  for (const k of FEATURE_KEYS) {
    out[k] = vectors.length ? vectors.reduce((s, v) => s + v[k], 0) / vectors.length : 0
  }
  return out
}

function nameCluster(members) {
  const counts = new Map()
  for (const t of members) {
    if (!t.artist) continue
    counts.set(t.artist, (counts.get(t.artist) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])
  if (!top.length) return 'Mix'
  return top.length === 1 ? `${top[0]} and more` : `${top[0]}, ${top[1]} and more`
}

function clusterLibrary({ tracks = [], vectors = new Map(), k = 5, rng = Math.random, previousCentroids = null } = {}) {
  const usable = tracks.filter(t => vectors.has(t.filePath))
  if (!usable.length) return { clusterOf: new Map(), centroids: [], names: [] }

  const norm = buildNormaliser(usable.map(t => vectors.get(t.filePath)))
  const pts = usable.map(t => normalise(vectors.get(t.filePath), norm))
  const kk = Math.max(1, Math.min(k, usable.length))

  // Reusing the previous centroids is what stops "your prog mix" becoming a
  // different mix every week for no reason the listener can see.
  let centroids = previousCentroids && previousCentroids.length === kk
    ? previousCentroids.map(c => ({ ...c }))
    : Array.from({ length: kk }, () => ({ ...pts[Math.floor(rng() * pts.length)] }))

  // -1, not 0: 0 is a real cluster index, so pre-filling with it makes the very
  // first assignment indistinguishable from "nothing moved". The loop would then
  // break before separating anything -- one cluster, every track in it.
  let assign = new Array(pts.length).fill(-1)
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity
      for (let c = 0; c < centroids.length; c++) {
        const d = distance(pts[i], centroids[c])
        if (d < bestD) { bestD = d; best = c }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true }
    }
    for (let c = 0; c < centroids.length; c++) {
      const members = pts.filter((_, i) => assign[i] === c)
      if (members.length) centroids[c] = meanVector(members)
    }
    if (!moved) break
  }

  const clusterOf = new Map()
  usable.forEach((t, i) => clusterOf.set(t.filePath, assign[i]))
  const names = centroids.map((_, c) => nameCluster(usable.filter((_, i) => assign[i] === c)))

  return { clusterOf, centroids, names }
}

module.exports = { clusterLibrary, MAX_ITERATIONS }
