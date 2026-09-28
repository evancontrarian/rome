#!/bin/sh
# One line: geometry, WM state, AT-SPI frame states, and whether the chat list shows.
W=$(xwininfo -display :100 -root -tree | awk '/"Weixin": \("wechat" "wechat"\)/ {print $1}')
G=$(xwininfo -display :100 -id "$W" | awk '/Absolute upper-left X/ {x=$NF} /Absolute upper-left Y/ {y=$NF} /Width/ {w=$NF} /Height/ {h=$NF} /Map State/ {m=$NF} END {print w"x"h"+"x"+"y, m}')
S=$(xprop -display :100 -id "$W" _NET_WM_STATE | sed 's/.*= //; s/_NET_WM_STATE_//g; s/_OB_WM_STATE_//g')
A=$(cd /home/rome/.rome/default/projects/.conductor-worktrees/ac8abdedf91a/t-0a325230-w-514cc394/packages/core/src/channels && DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus PYTHONPATH=/tmp/a11y/py python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('d', 'wechat-user-send-driver.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
f = d.main_frame(d.wechat_app()); st = f.states()
print('a11y active=%s showing=%s chats=%s' % (d.ACTIVE in st, d.SHOWING in st, bool(d.find(f, lambda n, s: n.role == 'list' and n.name == 'Chats'))))"; rm -rf __pycache__)
echo "$1 | win=$W geom=$G | state=[$S] | $A | X active=$(xprop -display :100 -root _NET_ACTIVE_WINDOW | awk '{print $NF}')"
