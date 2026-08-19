#!/usr/bin/env python3
"""Papa EQ — switch and edit the system-wide 6-channel EQ presets.

Switching a preset is instant: each preset is its own PipeWire filter-chain
sink, so it is only a default-sink change plus moving live streams.

Editing or adding one is not instant. A filter-chain graph is defined
statically in config and only built when the daemon starts, so a changed curve
needs PipeWire reloaded — roughly a two second audio drop. The UI says so
rather than letting it surprise you.
"""
import json, os, subprocess, sys
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
                             QListWidget, QListWidgetItem, QSlider, QPushButton,
                             QMessageBox, QInputDialog, QGroupBox, QFrame)

HOME = os.path.expanduser('~')
STORE = os.path.join(HOME, '.config/papa-eq/presets.json')
CAL = os.path.join(HOME, '.cache/speakercal.json')
GEN = os.path.join(HOME, 'flac-player/tools/build-pipewire-presets.js')
LIMIT = 12


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def load_store():
    with open(STORE) as fh:
        return json.load(fh)


def save_store(d):
    with open(STORE, 'w') as fh:
        json.dump(d, fh, indent=2)


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
            fl = QLabel(f'{hz//1000}k' if hz >= 1000 else str(hz))
            fl.setAlignment(Qt.AlignmentFlag.AlignHCenter)
            col.addWidget(vl); col.addWidget(s, 1); col.addWidget(fl)
            bl.addLayout(col)
            self.sliders.append(s); self.value_labels.append(vl)
        right.addWidget(box, 1)

        self.corr = QLabel(); self.corr.setWordWrap(True)
        self.corr.setFrameShape(QFrame.Shape.StyledPanel)
        self.corr.setText(self._correction_text())
        right.addWidget(self.corr)

        row = QHBoxLayout()
        self.save_btn = QPushButton('Save changes (reloads audio ~2s)')
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
        c = json.load(open(CAL))
        parts = [f"{x['freq']} Hz {x['gain']:+d} dB (Q{x['q']})" for x in c.get('corrections', [])]
        hp = max(28, round(c['low_limit'] * 0.9)) if c.get('low_limit') else '?'
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
        if subprocess.run(['pactl', 'set-default-sink', sink], capture_output=True).returncode != 0:
            QMessageBox.warning(self, 'Papa EQ',
                                f"{sink} does not exist yet.\nSave changes first to build it.")
            return
        for i in sh("pactl list sink-inputs short | cut -f1").split():
            subprocess.run(['pactl', 'move-sink-input', i, sink], capture_output=True)
        self._refresh_active()

    def _reset(self):
        for s in self.sliders:
            s.setValue(0)

    def _new(self):
        label, ok = QInputDialog.getText(self, 'New preset', 'Name:')
        if not ok or not label.strip():
            return
        key = ''.join(ch for ch in label.lower().replace(' ', '-') if ch.isalnum() or ch == '-')
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
        if QMessageBox.question(self, 'Papa EQ', f"Delete “{p['label']}”?") != QMessageBox.StandardButton.Yes:
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
        save_store(self.store)
        self._regenerate()
        self.dirty = False
        self.save_btn.setEnabled(False)

    def _regenerate(self):
        self.status.setText('Rebuilding filter graph…')
        QApplication.processEvents()
        r = subprocess.run(['node', GEN], capture_output=True, text=True)
        if r.returncode != 0:
            QMessageBox.critical(self, 'Papa EQ', f'Generator failed:\n{r.stderr[:500]}')
            return
        subprocess.run(['systemctl', '--user', 'restart', 'pipewire', 'pipewire-pulse', 'wireplumber'],
                       capture_output=True)
        QTimer.singleShot(9000, self._after_reload)

    def _after_reload(self):
        # A PipeWire restart drops the card back to a jack-detected profile, so
        # the 5.1 setup has to be reasserted or output silently falls back.
        subprocess.run(['systemctl', '--user', 'restart', 'papa-audio-51.service'], capture_output=True)
        QTimer.singleShot(6000, self._refresh_active)
        self.status.setText('Rebuilt.')


if __name__ == '__main__':
    if not os.path.exists(STORE):
        print(f'No preset store at {STORE}', file=sys.stderr)
        sys.exit(1)
    app = QApplication(sys.argv)
    w = PapaEQ(); w.show()
    sys.exit(app.exec())
