"""BrainFlow headset access: open + configure, read, close."""
import time

import numpy as np

from eeg import config


def open_board(board_id: int = config.BOARD_ID, port: str = config.SERIAL_PORT, log=print):
    """Start streaming and send the channel setup. Returns the BoardShim; close with close_board()."""
    from brainflow.board_shim import BoardShim, BrainFlowInputParams  # imported lazily: tests run without it

    params = BrainFlowInputParams()
    params.serial_port = port
    board = BoardShim(board_id, params)
    log(f"Connecting to board {board_id} on {port} ...")
    board.prepare_session()
    board.start_stream()
    time.sleep(3.0)
    log(f"Configuring {len(config.CHANNELS)} channels (~{len(config.BOARD_SETUP) * config.SETUP_PAUSE_S:.0f} s) ...")
    for cmd in config.BOARD_SETUP:
        board.config_board(cmd)
        time.sleep(config.SETUP_PAUSE_S)
    time.sleep(1.0)
    board.get_board_data()  # drop samples recorded while configuring
    n = len(BoardShim.get_eeg_channels(board_id))
    if n != len(config.CHANNELS):
        close_board(board)
        raise RuntimeError(f"board has {n} EEG channels, montage expects {len(config.CHANNELS)}")
    return board


def close_board(board):
    try:
        board.stop_stream()
    finally:
        board.release_session()


def read(board, board_id: int = config.BOARD_ID):
    """Everything buffered since the last call: (eeg (n_ch, k) in uV, timestamps (k,) unix seconds)."""
    from brainflow.board_shim import BoardShim

    data = board.get_board_data()
    if data.ndim != 2 or data.shape[1] == 0:
        return np.empty((len(config.CHANNELS), 0)), np.empty(0)
    return data[BoardShim.get_eeg_channels(board_id)], data[BoardShim.get_timestamp_channel(board_id)]


def sampling_rate(timestamps: np.ndarray, fallback: float = config.FS_NOMINAL) -> float:
    """Average rate over the whole span (robust to packets that share a timestamp)."""
    ts = np.asarray(timestamps, dtype=float)
    span = ts[-1] - ts[0] if ts.size > 10 else 0.0
    return (ts.size - 1) / span if span > 0 else float(fallback)
