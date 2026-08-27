// Range and toggle selection for list rows.
//
// Plain clicks must keep doing what they already do — playing the track — or
// every list in the app changes behaviour overnight. Selection is therefore
// only entered deliberately, with Shift or Ctrl/Cmd held. The interesting part
// is the anchor: Shift extends from the last deliberate click, not from the
// last selected row, which is what makes repeated Shift-clicks feel right
// instead of ratcheting.

function sortNums(a) { return a.slice().sort(function (x, y) { return x - y }) }

function rangeBetween(a, b) {
  var lo = Math.min(a, b)
  var hi = Math.max(a, b)
  var out = []
  for (var i = lo; i <= hi; i++) out.push(i)
  return out
}

function union(a, b) {
  var seen = {}
  var out = []
  var i
  for (i = 0; i < a.length; i++) { if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]) } }
  for (i = 0; i < b.length; i++) { if (!seen[b[i]]) { seen[b[i]] = 1; out.push(b[i]) } }
  return sortNums(out)
}

// opts: { index, shift, ctrl, selected[], anchor }
// Returns { selected[], anchor, mode }.
function applyClick(opts) {
  opts = opts || {}
  var index = opts.index
  var selected = (opts.selected || []).slice()
  var anchor = (typeof opts.anchor === 'number') ? opts.anchor : null
  var shift = !!opts.shift
  var ctrl = !!opts.ctrl

  if (typeof index !== 'number' || index < 0) {
    return { selected: selected, anchor: anchor, mode: 'none' }
  }

  if (shift && anchor !== null) {
    var range = rangeBetween(anchor, index)
    // Ctrl+Shift adds the range to what is already picked; Shift alone replaces.
    return {
      selected: ctrl ? union(selected, range) : range,
      anchor: anchor,          // the anchor deliberately does NOT move
      mode: 'range',
    }
  }

  if (ctrl) {
    var at = selected.indexOf(index)
    if (at >= 0) selected.splice(at, 1)
    else selected.push(index)
    return { selected: sortNums(selected), anchor: index, mode: 'toggle' }
  }

  // Shift with no anchor yet behaves as a first pick rather than doing nothing.
  return { selected: [index], anchor: index, mode: 'single' }
}

function isSelected(selected, index) {
  return (selected || []).indexOf(index) !== -1
}

function selectAll(total) {
  var out = []
  for (var i = 0; i < total; i++) out.push(i)
  return out
}

// After rows are added or removed, drop indices that no longer exist and pull
// the anchor back inside the list.
function clampToLength(selected, anchor, total) {
  var out = []
  for (var i = 0; i < (selected || []).length; i++) {
    if (selected[i] < total) out.push(selected[i])
  }
  var a = anchor
  if (typeof a !== 'number' || a >= total) a = out.length ? out[out.length - 1] : null
  return { selected: out, anchor: a }
}

function describe(count, noun) {
  noun = noun || 'track'
  return count + ' ' + noun + (count === 1 ? '' : 's') + ' selected'
}

// Named per file on purpose: eight scripts share one global scope, and a bare
// `var API` in each meant every later file overwrote the earlier binding. It
// was latent only because each one reads it on the next line.
var _PapaMultiSelect = {
  applyClick: applyClick,
  isSelected: isSelected,
  selectAll: selectAll,
  clampToLength: clampToLength,
  rangeBetween: rangeBetween,
  describe: describe,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaMultiSelect
if (typeof window !== 'undefined') window.PapaMultiSelect = _PapaMultiSelect
