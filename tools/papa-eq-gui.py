#!/usr/bin/env python3
"""Papa EQ — switch and edit the system-wide 6-channel EQ presets.

Switching a preset is instant: each preset is its own PipeWire filter-chain
sink, so it is only a default-sink change plus moving live streams.

Editing or adding one is not instant. A filter-chain graph is defined
statically in config and only built when the daemon starts, so a changed curve
needs PipeWire reloaded — roughly a two second audio drop. The UI says so
rather than letting it surprise you.
"""
import json, os, string, subprocess, sys
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
                             QListWidget, QListWidgetItem, QSlider, QPushButton,
                             QMessageBox, QInputDialog, QGroupBox, QFrame, QCheckBox)

HOME = os.path.expanduser('~')
STORE = os.path.join(HOME, '.config/papa-eq/presets.json')
CAL = os.path.join(HOME, '.cache/speakercal.json')
GEN = os.path.join(HOME, 'flac-player/tools/build-pipewire-presets.js')
APPLY = os.path.join(HOME, '.local/bin/papa-eq-apply')
LIMIT = 12

# Frequencies mean nothing without knowing what they do to the sound. These
# are the words people actually use to describe the problem they are trying
# to fix, in the order the sliders appear.
BAND_NAMES = {
    31: 'Deep bass', 62: 'Bass', 125: 'Punch', 250: 'Warmth', 500: 'Body',
    1000: 'Mids', 2000: 'Presence', 4000: 'Clarity', 8000: 'Detail', 16000: 'Air',
}


def sh(cmd, timeout=2):
    """Run a shell command, never blocking the GUI thread indefinitely.

    These calls happen on a repeating timer in the UI thread. pactl can hang
    while PipeWire is restarting, and without a timeout that freezes the whole
    window — it stops repainting and will not even close.
    """
    try:
        return subprocess.run(cmd, shell=True, capture_output=True,
                              text=True, timeout=timeout).stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        return ''


def load_store():
    with open(STORE) as fh:
        return json.load(fh)


def save_store(d):
    # Atomic: a truncated presets.json is unrecoverable and stops the GUI
    # starting at all.
    tmp = STORE + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(d, fh, indent=2)
    os.replace(tmp, STORE)


def _run(args, timeout=5):
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout).returncode
    except (subprocess.TimeoutExpired, OSError):
        return 1


class PapaEQ(QWidget):
    def __init__(self):
        super().__init__()
        self.store = load_store()
        self.bands = self.store['bands']
        self.dirty = False
        self.setWindowTitle('Papa EQ')
        self.resize(760, 460)
        self._build()
        self._reload_list()
        QTimer(self, timeout=self._refresh_active, interval=3000).start()

    def _confirm_discard(self):
        if not self.dirty:
            return True
        r = QMessageBox.question(self, 'Papa EQ', 'Discard unsaved slider changes?',
                                 QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        return r == QMessageBox.StandardButton.Yes

    def closeEvent(self, e):
        # dirty was tracked but never read, so edits vanished without a word.
        if not self._confirm_discard():
            e.ignore()
            return
        QApplication.quit()
        e.accept()

    # ---------- ui ----------
    def _build(self):
        root = QHBoxLayout(self)

        left = QVBoxLayout()
        left.addWidget(QLabel('<b>Presets</b>'))
        self.list = QListWidget()
        self.list.currentRowChanged.connect(self._on_select)
        self.list.itemDoubleClicked.connect(lambda _: self._activate())
        left.addWidget(self.list, 1)
        b = QPushButton('Activate');  b.clicked.connect(self._activate);  left.addWidget(b)
        b = QPushButton('New…');      b.clicked.connect(self._new);       left.addWidget(b)
        self.del_btn = QPushButton('Delete'); self.del_btn.clicked.connect(self._delete); left.addWidget(self.del_btn)
        root.addLayout(left, 0)

        right = QVBoxLayout()
        self.title = QLabel('<b>—</b>')
        right.addWidget(self.title)

        box = QGroupBox('Voicing (dB)')
        bl = QHBoxLayout(box)
        self.sliders, self.value_labels = [], []
        for hz in self.bands:
            col = QVBoxLayout()
            vl = QLabel('0'); vl.setAlignment(Qt.AlignmentFlag.AlignHCenter)
            s = QSlider(Qt.Orientation.Vertical)
            s.setRange(-LIMIT, LIMIT); s.setValue(0); s.setMinimumHeight(150)
            s.valueChanged.connect(self._on_slide)
            name = QLabel(BAND_NAMES.get(hz, ''))
            name.setAlignment(Qt.AlignmentFlag.AlignHCenter)
            name.setStyleSheet('font-size: 10px;')
            name.setWordWrap(True)
            fl = QLabel(f'{hz//1000}k' if hz >= 1000 else str(hz))
            fl.setAlignment(Qt.AlignmentFlag.AlignHCenter)
            fl.setStyleSheet('font-size: 9px; color: palette(mid);')
            col.addWidget(vl); col.addWidget(s, 1); col.addWidget(name); col.addWidget(fl)
            bl.addLayout(col)
            self.sliders.append(s); self.value_labels.append(vl)
        right.addWidget(box, 1)

        sub = QGroupBox('Subwoofer')
        sl = QHBoxLayout(sub)
        st = self.store.setdefault('settings', {})
        sl.addWidget(QLabel('Level'))
        self.lfe = QSlider(Qt.Orientation.Horizontal)
        self.lfe.setRange(0, 16); self.lfe.setValue(int(st.get('lfeBoost', 0)))
        self.lfe_lbl = QLabel(f"{self.lfe.value():+d} dB")
        self.lfe.valueChanged.connect(
            lambda v: (self.lfe_lbl.setText(f'{v:+d} dB'), self.save_btn.setEnabled(True)))
        sl.addWidget(self.lfe, 1); sl.addWidget(self.lfe_lbl)
        sl.addSpacing(12)
        sl.addWidget(QLabel('Hand over to sub below'))
        self.xover = QSlider(Qt.Orientation.Horizontal)
        self.xover.setRange(60, 160); self.xover.setValue(int(st.get('crossover', 100)))
        self.xover_lbl = QLabel(f'{self.xover.value()} Hz')
        self.xover.valueChanged.connect(
            lambda v: (self.xover_lbl.setText(f'{v} Hz'), self.save_btn.setEnabled(True)))
        sl.addWidget(self.xover, 1); sl.addWidget(self.xover_lbl)
        sub.setToolTip('Level: how loud the subwoofer is.\n'
                       'Hand over: below this, only the sub plays — raise it if the small\n'
                       'speakers sound strained, lower it if bass feels detached.')
        right.addWidget(sub)

        self.corr = QLabel(); self.corr.setWordWrap(True)
        self.corr.setFrameShape(QFrame.Shape.StyledPanel)
        self.corr.setText(self._correction_text())
        right.addWidget(self.corr)

        row = QHBoxLayout()
        self.save_btn = QPushButton('Save changes')
        self.save_btn.clicked.connect(self._save); self.save_btn.setEnabled(False)
        row.addWidget(self.save_btn)
        b = QPushButton('Reset to flat'); b.clicked.connect(self._reset); row.addWidget(b)
        right.addLayout(row)

        self.status = QLabel('—')
        right.addWidget(self.status)
        root.addLayout(right, 1)

    def _correction_text(self):
        if not os.path.exists(CAL):
            return 'No calibration found — run speakercal.'
        try:
            with open(CAL) as fh:
                c = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return 'Calibration file unreadable — run speakercal.'
        # :+d requires an int; a float gain raised ValueError during _build,
        # before the window existed, so the app just failed to appear.
        parts = [f"{x.get('freq','?')} Hz {x.get('gain',0):+g} dB (Q{x.get('q','?')})"
                 for x in c.get('corrections', [])]
        # settings.subHighPass (from the manufacturer spec) overrides the
        # by-ear low_limit; showing the by-ear figure reported a value that is
        # not the one in use.
        st = self.store.get('settings', {})
        hp = st.get('subHighPass') or (round(c['low_limit'] * 1.1) if c.get('low_limit') else '?')
        return (f"<b>Measured correction — applied under every preset:</b><br>"
                f"high-pass {hp} Hz · " + ' · '.join(parts))

    # ---------- state ----------
    def _reload_list(self):
        self.list.clear()
        for p in self.store['presets']:
            self.list.addItem(QListWidgetItem(p['label']))
        if self.store['presets']:
            self.list.setCurrentRow(0)
        self._refresh_active()

    def _current(self):
        i = self.list.currentRow()
        return self.store['presets'][i] if 0 <= i < len(self.store['presets']) else None

    def _on_select(self, _):
        p = self._current()
        if not p:
            return
        if self.dirty and not self._confirm_discard():
            pass  # selection already moved; the edit is lost either way
        self.title.setText(f"<b>{p['label']}</b>")
        for s, g in zip(self.sliders, p['gains']):
            s.blockSignals(True); s.setValue(int(g)); s.blockSignals(False)
        self._paint_values()
        self.dirty = False
        self.save_btn.setEnabled(False)
        self.del_btn.setEnabled(p['key'] != 'flat')

    def _paint_values(self):
        for s, l in zip(self.sliders, self.value_labels):
            v = s.value()
            l.setText('' if v == 0 else f'{v:+d}')

    def _on_slide(self):
        self._paint_values()
        self.dirty = True
        self.save_btn.setEnabled(True)

    def _refresh_active(self):
        cur = sh("pactl info | awk -F': ' '/Default Sink/{print $2}'")
        if cur.startswith('papa_eq_'):
            self.status.setText(f'Active: <b>{cur[len("papa_eq_"):]}</b>')
        else:
            self.status.setText(f'Active: {cur or "none"} — <b>not an EQ preset</b>')

    # ---------- actions ----------
    def _activate(self):
        p = self._current()
        if not p:
            return
        sink = f"papa_eq_{p['key']}"
        if _run(['pactl', 'set-default-sink', sink]) != 0:
            QMessageBox.warning(self, 'Papa EQ',
                                f"{sink} does not exist yet.\nSave changes first to build it.")
            return
        for i in sh("pactl list sink-inputs short | cut -f1").split():
            _run(['pactl', 'move-sink-input', i, sink])
        # Record it, or papa-audio-51.service restores a different preset at
        # the next login and the choice appears to have been forgotten.
        try:
            os.makedirs(os.path.join(HOME, '.config/papa-eq'), exist_ok=True)
            with open(os.path.join(HOME, '.config/papa-eq/active'), 'w') as fh:
                fh.write(sink + '\n')
        except OSError:
            pass
        self._refresh_active()

    def _reset(self):
        for s in self.sliders:
            s.setValue(0)

    def _new(self):
        label, ok = QInputDialog.getText(self, 'New preset', 'Name:')
        if not ok or not label.strip():
            return
        # str.isalnum() is Unicode-aware, but papa-eq-relink matches
        # [a-z0-9-] only — an accented name produced a preset that was silent
        # and nearly undiagnosable. Restrict to ASCII and reject empties.
        allowed = string.ascii_lowercase + string.digits + '-'
        key = ''.join(ch for ch in label.lower().replace(' ', '-') if ch in allowed).strip('-')
        if not key:
            QMessageBox.warning(self, 'Papa EQ', 'That name has no usable letters or digits.')
            return
        if any(p['key'] == key for p in self.store['presets']):
            QMessageBox.warning(self, 'Papa EQ', 'A preset with that name already exists.')
            return
        self.store['presets'].append(
            {'key': key, 'label': label.strip(), 'gains': [s.value() for s in self.sliders]})
        save_store(self.store)
        self._regenerate()
        self._reload_list()
        self.list.setCurrentRow(len(self.store['presets']) - 1)

    def _delete(self):
        p = self._current()
        if not p or p['key'] == 'flat':
            return
        if QMessageBox.question(self, 'Papa EQ',
                                f"Delete “{p['label']}”?\n\nThis rebuilds the filter graph — "
                                "audio drops for about 15 seconds.") != QMessageBox.StandardButton.Yes:
            return
        self.store['presets'] = [x for x in self.store['presets'] if x['key'] != p['key']]
        save_store(self.store)
        self._regenerate()
        self._reload_list()

    def _save(self):
        p = self._current()
        if not p:
            return
        p['gains'] = [s.value() for s in self.sliders]
        self.store.setdefault('settings', {})['lfeBoost'] = self.lfe.value()
        self.store['settings']['crossover'] = self.xover.value()
        save_store(self.store)

        # Regenerate the config so the change survives a reboot, then push the
        # values into the RUNNING graph. Every filter control is a live
        # PipeWire parameter, so this is ~300 ms and inaudible, instead of the
        # 15-20 seconds of silence a PipeWire restart costs.
        self.status.setText('Applying…')
        QApplication.processEvents()
        try:
            r = subprocess.run(['node', GEN], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            QMessageBox.critical(self, 'Papa EQ', f'Could not run the generator:\n{e}')
            return
        if r.returncode != 0:
            QMessageBox.critical(self, 'Papa EQ', f'Generator failed:\n{r.stderr[:500]}')
            return
        rc = _run([APPLY, p['key']], timeout=40)
        if rc == 2:
            # A band moved off zero, so its filter does not exist in the graph
            # yet. Only that case needs the slow path.
            self.status.setText('New band added — rebuilding…')
            QApplication.processEvents()
            self._reload_pipewire()
        elif rc != 0:
            self.status.setText('Apply failed — try Activate')
        else:
            self.status.setText('Applied live')
            QTimer.singleShot(2500, self._refresh_active)
        self.dirty = False
        self.save_btn.setEnabled(False)

    def _reload_pipewire(self):
        try:
            subprocess.run(['systemctl', '--user', 'restart', 'pipewire', 'pipewire-pulse', 'wireplumber'],
                           capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            pass
        QTimer.singleShot(9000, self._after_reload)

    def _regenerate(self):
        self.status.setText('Rebuilding filter graph…')
        QApplication.processEvents()
        try:
            r = subprocess.run(['node', GEN], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            QMessageBox.critical(self, 'Papa EQ', f'Could not run the generator:\n{e}')
            return
        if r.returncode != 0:
            QMessageBox.critical(self, 'Papa EQ', f'Generator failed:\n{r.stderr[:500]}')
            return
        try:
            subprocess.run(['systemctl', '--user', 'restart', 'pipewire', 'pipewire-pulse', 'wireplumber'],
                           capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            pass
        QTimer.singleShot(9000, self._after_reload)

    def _after_reload(self):
        # A PipeWire restart drops the card back to a jack-detected profile, so
        # the 5.1 setup has to be reasserted or output silently falls back.
        try:
            subprocess.run(['systemctl', '--user', 'restart', 'papa-audio-51.service'],
                           capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            pass
        QTimer.singleShot(6000, self._refresh_active)
        self.status.setText('Rebuilt.')


if __name__ == '__main__':
    if not os.path.exists(STORE):
        print(f'No preset store at {STORE}', file=sys.stderr)
        sys.exit(1)
    app = QApplication(sys.argv)
    w = PapaEQ(); w.show()
    sys.exit(app.exec())
