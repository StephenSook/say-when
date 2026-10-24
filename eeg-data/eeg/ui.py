"""Small Qt pieces shared by live.py and quiz.py."""
from PyQt5 import QtCore, QtGui, QtWidgets

from eeg.engine import Update

COLORS = {"left": (230, 70, 70), "right": (40, 120, 230), "rest": (60, 160, 80), "both": (170, 60, 190),
          "clench": (230, 150, 30), "jaw": (230, 150, 30)}


class Bar(QtWidgets.QWidget):
    """Horizontal bar 0..1 with an optional dashed marker and a grey 'ignored' state."""

    def __init__(self, name: str, marker: float = None, label: str = None):
        super().__init__()
        self.name, self.marker, self.label = name, marker, (label or name).upper()
        self.value, self.note, self.dim, self.bold = 0.0, "", False, False
        self.setMinimumHeight(50)

    def set(self, value: float, note: str = "", dim: bool = False):
        self.value, self.note, self.dim = float(value), note, dim
        self.update()

    def paintEvent(self, _):
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.Antialiasing)
        w, h, lw = self.width(), self.height(), 110
        bar = QtCore.QRectF(lw, 8, w - lw - 95, h - 16)
        f = p.font()
        f.setPointSize(13)
        f.setBold(True)
        p.setFont(f)
        p.setPen(QtGui.QColor(80, 80, 80))
        p.drawText(QtCore.QRectF(0, 0, lw - 10, h), QtCore.Qt.AlignVCenter | QtCore.Qt.AlignRight, self.label)
        p.setPen(QtCore.Qt.NoPen)
        p.setBrush(QtGui.QColor(232, 232, 232))
        p.drawRoundedRect(bar, 6, 6)
        color = QtGui.QColor(150, 150, 150) if self.dim else QtGui.QColor(*COLORS.get(self.name, (120, 120, 120)))
        p.setBrush(color.darker(130) if self.bold else color)
        p.drawRoundedRect(QtCore.QRectF(bar.left(), bar.top(), bar.width() * min(max(self.value, 0), 1),
                                        bar.height()), 6, 6)
        if self.marker is not None:
            x = bar.left() + bar.width() * self.marker
            p.setPen(QtGui.QPen(QtGui.QColor(20, 20, 20), 3, QtCore.Qt.DashLine))
            p.drawLine(QtCore.QPointF(x, bar.top() - 4), QtCore.QPointF(x, bar.bottom() + 4))
        p.setPen(QtGui.QColor(40, 40, 40))
        p.drawText(QtCore.QRectF(bar.right() + 8, 0, 90, h), QtCore.Qt.AlignVCenter, f"{self.value:.0%}{self.note}")
        p.end()


class EngineThread(QtCore.QThread):
    """Runs engine.start() and engine.poll() off the UI thread; emits every Update."""
    ready = QtCore.pyqtSignal()
    update = QtCore.pyqtSignal(object)
    failed = QtCore.pyqtSignal(str)

    def __init__(self, engine):
        super().__init__()
        self.engine, self._stop = engine, False

    def run(self):
        try:
            self.engine.start()
            self.ready.emit()
            while not self._stop:
                up: Update = self.engine.poll()
                if up.proba is not None or up.commands:
                    self.update.emit(up)
        except Exception as e:
            self.failed.emit(str(e))
        finally:
            self.engine.stop()

    def stop(self):
        self._stop = True
        self.wait(3000)


def app():
    a = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    a.setFont(QtGui.QFont("Segoe UI", 10))
    return a
