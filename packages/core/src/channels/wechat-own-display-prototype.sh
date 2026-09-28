#!/bin/sh
# PROTOTYPE, never merge. Round 4 of rome-work personal-wechat-replies
# (prototype-brief.md @ d2bc5d4), phase 1: give WeChat a display of its own.
#
#   sh wechat-own-display-prototype.sh up      # :100, its window manager, and a viewer on :99
#   sh wechat-own-display-prototype.sh a11y    # accessibility bus + registry, keys on :100
#   sh wechat-own-display-prototype.sh move    # restart the client on :100 (account data kept)
#   sh wechat-own-display-prototype.sh status
#   sh wechat-own-display-prototype.sh back    # put the client back on :99
#
# Nothing here changes Rome's config, routes or processes. The guardian sees
# :100 through a TigerVNC viewer window on :99, which /desktop already shows.
# Tools live under /tmp/wxd (Debian 12 debs, extracted; see fetch()).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
KIT="$HERE/wechat-own-display-prototype"
W=/tmp/wxd
LIB=$W/root/usr/lib/x86_64-linux-gnu
DISP=:100
PORT=5901
RUNTIME=/run/user/$(id -u)
CLIENT_ENV="HOME=$HOME QT_QPA_PLATFORM=xcb LIBGL_ALWAYS_SOFTWARE=1 XDG_RUNTIME_DIR=$RUNTIME DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME/bus"

log() { printf '%s %s\n' "$(date +%T)" "$*"; }

fetch() {
  [ -x $W/root/usr/bin/xtigervncviewer ] && return
  mkdir -p $W/deb && cd $W/deb
  for f in t/tigervnc/tigervnc-viewer_1.12.0+dfsg-8_amd64.deb f/fltk1.3/libfltk1.3_1.3.8-5_amd64.deb \
           f/fltk1.3/libfltk-images1.3_1.3.8-5_amd64.deb x/xdotool/xdotool_3.20160805.1-5_amd64.deb \
           x/xdotool/libxdo3_3.20160805.1-5_amd64.deb; do
    curl -sSfLO "https://deb.debian.org/debian/pool/main/$f" && dpkg-deb -x "$(basename "$f")" $W/root
  done
  cd - >/dev/null
}

up() {
  fetch
  if ! xwininfo -display $DISP -root >/dev/null 2>&1; then
    setsid Xtigervnc $DISP -geometry 1280x800 -depth 24 -SecurityTypes None -localhost yes \
      -rfbport $PORT -AlwaysShared -AcceptCutText -SendCutText -ac >$W/xvnc.log 2>&1 </dev/null &
    for _ in 1 2 3 4 5 6 7 8 9 10; do xwininfo -display $DISP -root >/dev/null 2>&1 && break; sleep 0.3; done
    log "display $DISP up (TigerVNC on localhost:$PORT)"
  fi
  if ! pgrep -f "openbox --config-file $KIT/openbox-rc.xml" >/dev/null; then
    DISPLAY=$DISP setsid openbox --config-file "$KIT/openbox-rc.xml" >$W/openbox.log 2>&1 </dev/null &
    log "openbox on $DISP with $KIT/openbox-rc.xml"
  fi
  if ! pgrep -f "xtigervncviewer.*localhost:$PORT" >/dev/null; then
    LD_LIBRARY_PATH=$LIB setsid $W/root/usr/bin/xtigervncviewer -display :99 -Shared -RemoteResize=0 \
      localhost:$PORT >$W/viewer.log 2>&1 </dev/null &
    log "viewer for $DISP on :99 (visible at /desktop)"
  fi
}

a11y() {
  # Round 2/3's stand-in for at-spi-bus-launcher: #504 is not in the running image.
  # DISPLAY=:100 so the registry's keyboard events (XTest) land on WeChat's display.
  pgrep -f 'a11y_bus.py' >/dev/null && { log "accessibility bus already running"; return; }
  DISPLAY=$DISP DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME/bus python3 "$KIT/a11y_bus.py" --background
}

move() {
  up
  if pgrep -x wechat >/dev/null; then
    pkill -x wechat
    for _ in $(seq 1 50); do pgrep -x wechat >/dev/null || break; sleep 0.2; done
    log "client on the old display stopped"
  fi
  pgrep -x wechat >/dev/null && { log "a client is still running; not starting another"; exit 1; }
  (cd /opt/wechat && env DISPLAY=$DISP $CLIENT_ENV setsid /opt/wechat/wechat >$W/client.log 2>&1 </dev/null &)
  log "client started on $DISP"
}

back() {
  pkill -x wechat || true
  for _ in $(seq 1 50); do pgrep -x wechat >/dev/null || break; sleep 0.2; done
  (cd /opt/wechat && env DISPLAY=:99 $CLIENT_ENV setsid /opt/wechat/wechat >$W/client.log 2>&1 </dev/null &)
  log "client started on :99; the guardian signs in at /desktop"
}

status() {
  echo "client:"; ps -o pid,etime,args -p "$(pgrep -x wechat | tr '\n' ',' | sed 's/,$//')" 2>/dev/null || echo "  not running"
  for p in $(pgrep -x wechat); do echo "  pid $p $(tr '\0' '\n' </proc/$p/environ | grep '^DISPLAY=')"; done
  for d in :99 $DISP; do echo "WeChat windows on $d:"; xwininfo -display $d -root -tree 2>/dev/null | grep -E '"(wechat|Weixin)"' | sed 's/^ */  /'; done
  echo "active window on $DISP: $(xprop -display $DISP -root _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}')"
}

case "${1:-status}" in
  up) up ;; a11y) a11y ;; move) move ;; back) back ;; status) status ;;
  *) echo "usage: $0 up|a11y|move|status|back" >&2; exit 2 ;;
esac
