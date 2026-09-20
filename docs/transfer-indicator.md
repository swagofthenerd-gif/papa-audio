# Transfer indicator

The sidebar says what is moving, in both directions, without anyone having to
open a page to find out.

## The downloads pill

The Downloads row in the sidebar carries a small pill: `↓ 3` means three files
are actually coming in, `↓ 3 +12` means twelve more are queued behind them, and
`↓ +12` means everything is still waiting its turn. With nothing coming in the
pill disappears rather than sitting there showing zero. Files the scheduler is
still holding — asked for but not yet handed to slskd — are deliberately not
counted; the pill is about what is in flight, not what is on the wishlist. The
number is painted inside the downloads poll that already runs, from the
snapshot it already fetched, so the pill costs nothing extra.

## The Sharing row

A second sidebar row appears under Downloads only when there is something to
say: `↑ 2` while peers are pulling files out of your library, or a quiet
`14 today` once they have stopped but something went out during the day. On a
day where nobody took anything the row is not there at all. It refreshes every
minute, and that refresh is answered from whatever the main process saw the last
time it polled the daemon, however old that is — so the sidebar asks the daemon
for nothing, apart from the first refresh of a session if no poll has landed
yet. The price is that the number can lag: the upload poll runs every minute
while files are going out but drops to five minutes when nothing is, so on a
quiet day the row can be a few minutes behind. That is the trade on purpose — a
sidebar tally is not worth extra requests, and anything that actually starts
moving pushes an update immediately rather than waiting for a tick. While the
app window is hidden the refresh stops entirely.

The Downloads row's older badge stands down while the pill is showing. Both were
drawn on the same row and both appear when there is a queue, so the pill — which
carries what is moving *and* what is waiting — is the one that stays, and the
badge is left to do what only it does: the count of what finished today.

## The sharing panel

Clicking the Sharing row slides out a panel, the same kind of slide-over as the
queue. Each line is one upload: who is taking it, the file name with its album
folder in small type underneath, a progress bar, and the speed. Live transfers
sort to the top so the ones being watched do not jump around. Under the list is
the day's sentence — "14 files to 3 people today · 2.1 GB" — and when nobody is
pulling anything the panel says so instead of showing an empty box. If the
Soulseek daemon cannot be reached at all the panel says that instead, rather
than reporting a list it could not fetch as nobody wanting anything. Clicking a
peer's name opens their library, because whoever is taking your files is often
worth browsing back. While the panel is open it refreshes every ten seconds so
the bars move; that stops the moment it closes, and Escape closes it. Opening it
closes the queue panel, which shares the same slot on the right.

## The day's counters

"Today" means the local calendar day, and it resets at midnight. Three numbers
are kept: bytes sent, distinct people served, and files delivered. A file counts
as delivered when the daemon reports it finished successfully — a cancelled or
errored transfer does not count — and each peer-and-file pair counts once, so a
finished transfer the daemon keeps reporting is not added again on every poll.
Once counted, a file stays counted for the rest of the day even after the daemon
drops the row.

## Where the code is

`src/transfer-indicator.js` is the pure half: it turns snapshots into the pill
text, the panel rows and the day sentence, and has no DOM or clock in it
(`test/transfer-indicator.test.js`). `src/upload-stats.js` holds the daily
counters and the midnight rollover (`test/upload-stats.test.js`). The main
process polls the daemon and answers the `slsk-upload-stats` channel; the
renderer paints. `test/transfer-indicator-ipc.test.js` pins the wiring on both
sides — that the pill rides the existing poll, that the refreshes are the two
timers they are supposed to be, and that everything a peer controls is escaped.
