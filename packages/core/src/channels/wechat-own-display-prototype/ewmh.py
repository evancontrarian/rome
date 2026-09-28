"""EWMH client messages on a display (test harness): maximize, unmaximize, activate."""
import ctypes, sys
X = ctypes.cdll.LoadLibrary("libX11.so.6")
X.XOpenDisplay.restype = ctypes.c_void_p; X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XInternAtom.restype = ctypes.c_ulong; X.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
X.XDefaultRootWindow.restype = ctypes.c_ulong; X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
class XClientMessageEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
class XEvent(ctypes.Union):
    _fields_ = [("xclient", XClientMessageEvent), ("pad", ctypes.c_long * 24)]
X.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
X.XFlush.argtypes = [ctypes.c_void_p]
def send(display, win, msg, data):
    d = X.XOpenDisplay(display.encode()); root = X.XDefaultRootWindow(d)
    ev = XEvent(); c = ev.xclient
    c.type = 33; c.send_event = 1; c.display = d; c.window = win; c.format = 32
    c.message_type = X.XInternAtom(d, msg.encode(), 0)
    for i, v in enumerate(data):
        c.data[i] = X.XInternAtom(d, v.encode(), 0) if isinstance(v, str) else v
    X.XSendEvent(d, root, 0, (1 << 20) | (1 << 19), ctypes.byref(ev)); X.XFlush(d)
if __name__ == "__main__":
    display, win, op = sys.argv[1], int(sys.argv[2], 16), sys.argv[3]
    if op in ("maximize", "unmaximize"):
        send(display, win, "_NET_WM_STATE", [1 if op == "maximize" else 0, "_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ", 1, 0])
    elif op == "activate":
        send(display, win, "_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0])
