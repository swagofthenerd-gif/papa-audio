// Turns a Soulseek user's shared-file listing into a navigable tree.
//
// slskd returns a flat array of directories, each with a full Windows-style
// path ("Music\\Rock\\Album\\") and its files. That is fine for searching but
// impossible to browse: a user with 4,000 folders is a wall of text. This
// rebuilds the hierarchy so the UI can walk it one level at a time, with the
// back/forward behaviour people expect from a file manager.

const SEP = '\\'

function splitPath(p) {
  return String(p || '').replace(/\//g, SEP).split(SEP).filter(Boolean)
}

// Deliberately broad. A hidden audio file looks like data loss to the user,
// whereas an extra oddity in the list is merely untidy.
const AUDIO_RE = /\.(flac|mp3|wav|aiff?|aif|m4a|m4b|aac|ogg|oga|opus|ape|wv|wma|dsf|dff|mka|ec3|ac3|alac|mpc|tta|shn|dts|spx|caf|w64)$/i

function makeNode(name, path) {
  // dirs is keyed by lowercased name: Windows paths are case-insensitive and
  // peers really do share both "Dark The Suns" and "Dark the Suns". Keying by
  // exact name splits one album across two folders, so half its files appear
  // to be missing from whichever one you open.
  return { name, path, dirs: new Map(), files: [], fileCount: 0, totalSize: 0 }
}

// Directory entries carry the full path; files inside carry only a basename.
function buildTree(directories) {
  const root = makeNode('', '')
  for (const d of directories || []) {
    const parts = splitPath(d.name)
    let node = root
    let acc = []
    for (const part of parts) {
      acc.push(part)
      const key = part.toLowerCase()
      if (!node.dirs.has(key)) node.dirs.set(key, makeNode(part, acc.join(SEP)))
      node = node.dirs.get(key)
      // Walk on using the casing we first saw, so node.path stays self-consistent.
      acc[acc.length - 1] = node.name
    }
    for (const f of d.files || []) {
      const base = splitPath(f.filename).pop() || f.filename || ''
      // fullPath must use the peer's own casing for this entry - it is what we
      // send back to request the download - not the merged display casing.
      node.files.push({ ...f, name: base, fullPath: (d.name ? d.name + SEP : '') + base })
    }
  }
  // Roll counts and sizes up so a folder can show what it contains without
  // the UI having to walk it.
  const roll = (n) => {
    let count = n.files.length
    let size = n.files.reduce((s, f) => s + (Number(f.size) || 0), 0)
    for (const c of n.dirs.values()) { const r = roll(c); count += r.count; size += r.size }
    n.fileCount = count; n.totalSize = size
    return { count, size }
  }
  roll(root)
  return root
}

function getNode(root, path) {
  let node = root
  for (const part of splitPath(path)) {
    const next = node.dirs.get(part.toLowerCase())
    if (!next) return null
    node = next
  }
  return node
}

function parentPath(path) {
  const parts = splitPath(path)
  parts.pop()
  return parts.join(SEP)
}

function breadcrumbs(path) {
  const parts = splitPath(path)
  const out = [{ name: 'Library', path: '' }]
  let acc = []
  for (const p of parts) { acc.push(p); out.push({ name: p, path: acc.join(SEP) }) }
  return out
}

// One level of listing, sorted the way file managers do: folders first, then
// files, each alphabetically and case-insensitively.
function listDir(root, path, { sort = 'name', audioOnly = false } = {}) {
  const node = getNode(root, path)
  if (!node) return null
  const dirs = [...node.dirs.values()].map(d => ({
    name: d.name, path: d.path, fileCount: d.fileCount, totalSize: d.totalSize,
    subdirCount: d.dirs.size,
  }))
  let files = node.files.slice()
  if (audioOnly) files = files.filter(f => AUDIO_RE.test(f.name))

  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
  const cmp = {
    name: byName,
    size: (a, b) => (Number(b.size ?? b.totalSize) || 0) - (Number(a.size ?? a.totalSize) || 0),
    type: (a, b) => String(a.name.split('.').pop()).localeCompare(String(b.name.split('.').pop())) || byName(a, b),
  }[sort] || byName

  dirs.sort(sort === 'size' ? cmp : byName)
  files.sort(cmp)
  return { path, node, dirs, files, parent: path === '' ? null : parentPath(path) }
}

// Browser-style history: navigating after going back discards the forward tail.
class NavHistory {
  constructor(start = '') { this.stack = [start]; this.index = 0 }
  get current() { return this.stack[this.index] }
  get canBack() { return this.index > 0 }
  get canForward() { return this.index < this.stack.length - 1 }
  go(path) {
    if (path === this.current) return this.current
    this.stack = this.stack.slice(0, this.index + 1)
    this.stack.push(path)
    this.index = this.stack.length - 1
    return this.current
  }
  back() { if (this.canBack) this.index--; return this.current }
  forward() { if (this.canForward) this.index++; return this.current }
}

// Search the whole tree, not just the current folder — the flat filter the old
// UI had was genuinely useful and should not be lost to navigation.
function searchTree(root, query, limit = 300) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const out = []
  const walk = (n) => {
    if (out.length >= limit) return
    for (const d of n.dirs.values()) {
      if (d.path.toLowerCase().includes(q)) out.push({ type: 'dir', name: d.name, path: d.path, fileCount: d.fileCount })
      walk(d)
    }
    for (const f of n.files) {
      if (out.length >= limit) return
      if (f.name.toLowerCase().includes(q)) out.push({ type: 'file', name: f.name, path: n.path, file: f })
    }
  }
  walk(root)
  return out.slice(0, limit)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTree, getNode, listDir, breadcrumbs, parentPath, searchTree, NavHistory, splitPath, AUDIO_RE }
}
if (typeof window !== 'undefined') {
  window.PapaSlskTree = { buildTree, getNode, listDir, breadcrumbs, parentPath, searchTree, NavHistory, AUDIO_RE }
}
