# Network mode switch

Two internet connections, one switch.

```bash
papa-net-mode            # what is happening right now
papa-net-mode boost      # merge both connections
papa-net-mode normal     # back to Ethernet only
papa-net-mode toggle     # flip (this is what the tray icon does)
papa-net-mode verify     # does the real routing match what was asked for?
```

This machine has two genuinely separate connections — the Ethernet port and a
USB WiFi dongle, on different ISPs with different public addresses and
different routers, both of which happen to answer at 192.168.18.1 on their own
link.

| | interface | address | speed | latency | jitter |
|---|---|---|---|---|---|
| Ethernet | `enp37s0` | 192.168.18.4 | 10.8 MB/s | 3.6 ms | 1.0 ms |
| WiFi 5 GHz | `wlp43s0f3u2` | 192.168.18.217 (1-hour lease) | 6.4 MB/s | 79.8 ms | 74.8 ms |

Merged, they measure **14.6 MB/s** — about a third more than Ethernet alone.

## When boost actually helps, and when it hurts

The kernel spreads traffic **per connection**, not per packet. One download
rides one link for its whole life. So:

- **Helps**: work spread across many connections at once — a torrent with
  dozens of peers. Roughly a third more throughput.
- **Does nothing**: a single big download. It picks one link and stays there —
  and there is a real chance that link is the slower one.
- **Hurts**: anything latency-bound that happens to land on the WiFi link.
  80 ms average, 75 ms of jitter, spikes to 266 ms. A game would be unplayable
  on it.

That is why this is a switch and not a setting, and why nothing here survives a
reboot: the machine always starts back on Ethernet alone.

## Try this first

WiFi power saving is on, and USB autosuspend is 2000 ms. That is the classic
cause of exactly this latency shape — a 4.9 ms floor with an 80 ms average.

```bash
sudo iw dev wlp43s0f3u2 set power_save off
```

If that flattens the jitter, the WiFi link stops being something to keep away
from your games, and this switch becomes far less interesting. Worth ten
seconds before installing anything.

## What gets installed

Four things you own, and three that need root.

| Path | Owner | What it is |
|---|---|---|
| `~/.local/bin/papa-net-mode` | you | the command above |
| `~/.local/bin/papa-net-tray` | you | the tray icon |
| `~/.config/systemd/user/papa-net-tray.service` | you | starts the tray at login |
| `/usr/local/libexec/papa-net-apply` | **root** | the only privileged part |
| `/etc/sudoers.d/papa-net-mode` | **root** | lets the tray switch without a password |
| `/etc/NetworkManager/dispatcher.d/no-wait.d/90-papa-net-mode` | **root** | re-applies after a lease renewal |
| `/var/lib/papa-net/mode` | **root** | one word: what you asked for |

## The one thing to understand before installing

You are granting one command the right to run as root without a password.

`sudo` does **not** check who owns the file it runs, or what is in it. It
matches the path and runs whatever is there at that moment. So that grant is
worth exactly as much as write access to that path. That is why the privileged
script lives at `/usr/local/libexec/papa-net-apply`, owned by root, with every
parent directory owned by root — and not anywhere under your home directory,
where anything running as you could rewrite it and become root silently.

The rule names four exact words (`boost`, `normal`, `reapply`, `status`). It is
not a wildcard, on purpose: `ip` running as root can execute arbitrary commands
(`ip netns exec … /bin/sh`), so a rule that allowed any arguments would be a
root shell by another name.

## Installing the root half

Do this with a second terminal already holding a root shell (`sudo -i`). A
broken file in `/etc/sudoers.d` can lock you out of `sudo` entirely, and that
spare shell is your way back.

```bash
sudo install -o root -g root -d -m 0755 /var/lib/papa-net
sudo install -o root -g root -m 0755 -D ~/flac-player/tools/papa-net-apply /usr/local/libexec/papa-net-apply
sudo install -o root -g root -m 0755 -D ~/flac-player/tools/90-papa-net-mode /etc/NetworkManager/dispatcher.d/no-wait.d/90-papa-net-mode
sudo ln -sfn no-wait.d/90-papa-net-mode /etc/NetworkManager/dispatcher.d/90-papa-net-mode
```

Then the sudoers rule. `visudo` validates before it saves and refuses to write
a broken file, which removes the lockout risk:

```bash
sudo visudo -f /etc/sudoers.d/papa-net-mode
```

Paste the contents of `~/flac-player/tools/papa-net-mode.sudoers`, save, and
check it took:

```bash
sudo visudo -c && sudo -n -l | grep papa-net-apply
```

The filename must have **no extension**. Fedora's `/etc/sudoers` skips any file
in that directory containing a `.`, silently — the switch would just keep
asking for a password with nothing to explain why.

Finally, the tray:

```bash
systemctl --user daemon-reload
systemctl --user enable --now papa-net-tray.service
```

## Checking it worked

Before switching anything, write down what normal looks like:

```bash
ip route show ; ip rule show
ip route get 1.1.1.1 from 192.168.18.217
```

That last one is the interesting one. Today it answers `dev enp37s0` — traffic
from the WiFi address leaves over Ethernet. After `papa-net-mode boost` it must
say `dev wlp43s0f3u2`. That single line is the best proof the switch worked.

Then:

```bash
papa-net-mode boost
papa-net-mode verify          # must print OK: boost
ip route show default         # two nexthops, weights 5 and 3
```

Check something on your own network still works — KDE Connect, the printer, a
file share. If those die the moment you boost, the per-link subnet routes are
missing and you should say so rather than working around it.

```bash
papa-net-mode normal
ip route show                 # must match what you wrote down
```

## Safety

`boost` arms a deadman before it changes anything globally visible: if the
script is killed, the terminal dies, or verification hangs, the machine puts
itself back to normal after ninety seconds, unattended. Run the first switch
from a local terminal — never over SSH.

If only the WiFi side fails, it does **not** roll all the way back. It drops to
Ethernet-only and keeps the rules in place, so the dispatcher can promote it
back the next time WiFi returns without you doing anything.

## Undoing it

```bash
papa-net-mode normal
systemctl --user disable --now papa-net-tray.service
rm -f ~/.local/bin/papa-net-mode ~/.local/bin/papa-net-tray
rm -f ~/.config/systemd/user/papa-net-tray.service
sudo rm -f /etc/NetworkManager/dispatcher.d/90-papa-net-mode
sudo rm -f /etc/NetworkManager/dispatcher.d/no-wait.d/90-papa-net-mode
sudo rm -f /etc/sudoers.d/papa-net-mode && sudo visudo -c
sudo rm -f /usr/local/libexec/papa-net-apply
sudo rm -rf /var/lib/papa-net
```

Remove the sudoers rule in the same sitting as the binary, and before it. A
`NOPASSWD` line pointing at a path that no longer exists is inert today and a
passwordless root shell the moment anything ever creates that path again.

The routing itself needs no undoing. Nothing is ever written into
NetworkManager's connection profiles, so a reboot alone returns the machine to
stock — that is deliberate, not luck.
