#!/usr/bin/env python3
"""papa-net-tray — a tray switch for this machine's two internet connections.

Left click flips between them. The icon says which one is live, so it answers
the question without being clicked. Everything it does goes through
papa-net-mode; this file holds no privilege and no routing knowledge of its own.

PyQt6 rather than AppIndicator, for two reasons that matter here: the
maintained Ayatana namespace is not installed on this machine (only the
abandoned libappindicator fork), and libappindicator has no primary-activate
signal at all — left click always just opens the menu, which is precisely the
one-click switch this is for.
"""
import os
import subprocess
import sys

from PyQt6.QtCore import QFileSystemWatcher, QObject, QProcess, QTimer, pyqtSlot
from PyQt6.QtDBus import QDBusConnection
from PyQt6.QtGui import QAction, QActionGroup, QIcon
from PyQt6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon

MODE_BIN = os.path.expanduser("~/.local/bin/papa-net-mode")
# The privileged half. Its absence does not stop the tray READING the current
# mode — that comes from the routing table — but it does stop it changing one,
# and a switch that looks live and then silently fails is worse than one that
# says it cannot.
APPLY_BIN = "/usr/local/libexec/papa-net-apply"
STATE = "/var/lib/papa-net/mode"
STATE_DIR = "/var/lib/papa-net"

# Verified present under /usr/share/icons/breeze on this machine. QIcon.fromTheme
# returns a NULL icon for a name the theme lacks, and setIcon(null) shows nothing
# at all with no error — an invisible tray item — so every lookup is checked.
ICONS = {
    "normal":   "network-wired-activated",
    "boost":    "network-wireless-connected-100",
    "degraded": "network-limited",
    "broken":   "dialog-warning",
}

WORDS = {
    "normal":   ("Ethernet only", "One connection. Low latency — what games and calls want."),
    "boost":    ("Both connections", "More total speed across many downloads.\nAnything landing on WiFi gets its jitter."),
    "degraded": ("Degraded", "Both were asked for, but only one link is carrying."),
    "broken":   ("Not available", "papa-net-mode is missing, or the passwordless rule is not installed."),
}


def read_now(timeout=2.0):
    """One word: normal | boost | degraded | broken. Never raises."""
    if not os.access(MODE_BIN, os.X_OK):
        return "broken"
    try:
        out = subprocess.run([MODE_BIN, "current"], capture_output=True,
                             text=True, timeout=timeout)
        word = (out.stdout or "").strip()
        return word if word in ("normal", "boost", "degraded") else "broken"
    except Exception:
        return "broken"


def icon_for(state):
    icon = QIcon.fromTheme(ICONS.get(state, ICONS["broken"]))
    if icon.isNull():
        icon = QIcon.fromTheme("network-wired")
    if icon.isNull():
        icon = QIcon.fromTheme("dialog-warning")
    return icon


class Tray(QObject):
    # A QObject on purpose: QDBusConnection.connect needs a QObject receiver
    # with a real slot, and a plain class silently fails to subscribe — the
    # tray would then miss every NetworkManager event and rely on the
    # sixty-second backstop alone.
    def __init__(self, app):
        super().__init__()
        self.app = app
        self.state = "broken"
        self.can_switch = False
        self.busy = False
        self.proc = None

        self.tray = QSystemTrayIcon()
        self.menu = QMenu()

        # Radio items rather than one Toggle entry, so the menu DISPLAYS the
        # state as well as offering the action — the same reason the icon
        # differs per mode.
        self.group = QActionGroup(self.menu)
        self.group.setExclusive(True)
        self.act_normal = QAction("Ethernet only", self.menu, checkable=True)
        self.act_boost = QAction("Both connections", self.menu, checkable=True)
        for a in (self.act_normal, self.act_boost):
            self.group.addAction(a)
            self.menu.addAction(a)
        self.act_normal.triggered.connect(lambda: self.apply("normal"))
        self.act_boost.triggered.connect(lambda: self.apply("boost"))

        self.menu.addSeparator()
        act_recheck = QAction("Re-check now", self.menu)
        act_recheck.triggered.connect(self.refresh)
        self.menu.addAction(act_recheck)
        act_status = QAction("Status…", self.menu)
        act_status.triggered.connect(self.show_status)
        self.menu.addAction(act_status)
        self.menu.addSeparator()
        act_quit = QAction("Quit", self.menu)
        act_quit.triggered.connect(app.quit)
        self.menu.addAction(act_quit)

        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self.on_activated)

        # Three ways to notice a change, because each covers a case the others
        # structurally cannot.
        #
        # 1. The state file, for a switch made from a terminal.
        self.fsw = QFileSystemWatcher()
        for p in (STATE, STATE_DIR):
            if os.path.exists(p):
                self.fsw.addPath(p)
        self.fsw.fileChanged.connect(self.on_state_file)
        self.fsw.directoryChanged.connect(self.on_state_file)

        # 2. NetworkManager's own signal, for the case the file CANNOT show:
        #    the recorded mode staying the same while reality drifts out from
        #    under it — a lease renewal, a carrier change, a dropped link.
        bus = QDBusConnection.systemBus()
        # PyQt6's overload takes the callable directly — there is no
        # (receiver, signature) form here.
        ok = bus.connect("org.freedesktop.NetworkManager",
                         "/org/freedesktop/NetworkManager",
                         "org.freedesktop.NetworkManager", "StateChanged",
                         self.on_nm_changed)
        if not ok:
            sys.stderr.write("papa-net-tray: could not subscribe to NetworkManager; "
                             "falling back to the periodic check\n")

        # 3. A slow backstop for drift caused by something outside NM entirely.
        self.backstop = QTimer()
        self.backstop.setInterval(60_000)
        self.backstop.timeout.connect(self.refresh)
        self.backstop.start()

        # NM emits a burst during any reconnect; one refresh is enough.
        self.debounce = QTimer()
        self.debounce.setSingleShot(True)
        self.debounce.setInterval(250)
        self.debounce.timeout.connect(self.refresh)

        # plasmashell owns the StatusNotifierWatcher this registers with. Start
        # before it exists and show() silently does nothing, so wait for it.
        self.waited = 0
        self.wait_timer = QTimer()
        self.wait_timer.setInterval(1000)
        self.wait_timer.timeout.connect(self.try_show)
        self.try_show()

        self.refresh()

    def try_show(self):
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray.show()
            self.wait_timer.stop()
            return
        self.waited += 1
        if self.waited == 1:
            self.wait_timer.start()
        elif self.waited > 30:
            self.wait_timer.stop()
            sys.stderr.write("papa-net-tray: no system tray after 30 s; giving up\n")
            self.app.quit()

    def on_state_file(self, _path=None):
        # The helper writes atomically (write temp, then rename), so the inode
        # is REPLACED and inotify fires IN_DELETE_SELF — Qt then drops the watch
        # permanently. Re-arm every time, or this works exactly once and then
        # goes quiet forever.
        if STATE not in self.fsw.files() and os.path.exists(STATE):
            self.fsw.addPath(STATE)
        self.debounce.start()

    @pyqtSlot("uint")
    def on_nm_changed(self, _state=0):
        self.debounce.start()

    def refresh(self):
        self.state = read_now()
        self.can_switch = os.path.exists(APPLY_BIN)
        self.tray.setIcon(icon_for(self.state))
        head, detail = WORDS.get(self.state, WORDS["broken"])
        if not self.can_switch and self.state != "broken":
            detail += "\n\nRead-only: the privileged helper is not installed yet."
        self.tray.setToolTip(f"Network: {head}\n{detail}")
        self.act_normal.setChecked(self.state == "normal")
        self.act_boost.setChecked(self.state in ("boost", "degraded"))
        for a in (self.act_normal, self.act_boost):
            a.setEnabled(self.state != "broken" and self.can_switch and not self.busy)

    def on_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            if not self.can_switch:
                self.show_status()
                return
            self.apply("normal" if self.state in ("boost", "degraded") else "boost")

    def apply(self, want):
        if self.busy or self.state == "broken" or not self.can_switch:
            self.refresh()
            return
        # QProcess, not subprocess: this one calls sudo and touches the network,
        # and a blocking call on the UI thread froze papa-eq-gui so hard it
        # would not even close. That lesson is recorded in its source; do not
        # relearn it here.
        self.busy = True
        self.refresh()
        self.proc = QProcess()
        self.proc.finished.connect(lambda *_: self.done())
        self.proc.errorOccurred.connect(lambda *_: self.done())
        self.proc.start(MODE_BIN, [want])

    def done(self):
        self.busy = False
        self.proc = None
        self.refresh()

    def show_status(self):
        try:
            out = subprocess.run([MODE_BIN, "status"], capture_output=True,
                                 text=True, timeout=5).stdout
        except Exception as exc:
            out = f"could not read status: {exc}"
        box = QMessageBox()
        box.setWindowTitle("Network mode")
        box.setText(out or "(no output)")
        box.exec()


def main():
    app = QApplication(sys.argv)
    # A tray-only app has no windows; without this it exits the moment a dialog
    # closes.
    app.setQuitOnLastWindowClosed(False)
    # ~/.config/kdeglobals has no [Icons] section, so the theme comes from
    # defaults — which a bare systemd unit environment may not reproduce.
    if QIcon.themeName() in ("", "hicolor"):
        QIcon.setThemeName("breeze")
    Tray(app)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
