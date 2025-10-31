// SPDX-License-Identifier: MIT
'use strict';

const { Gio, Meta, Shell, Clutter, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const IFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.WMCtrl1">
    <method name="ListWindows">
      <arg type="s" name="text" direction="out"/>
    </method>
    <method name="ActivateById">
      <arg type="s" name="id" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="GetActiveWorkspace">
      <arg type="s" name="index" direction="out"/>
    </method>
    <method name="GetActiveWindow">
      <arg type="s" name="id" direction="out"/>
    </method>
    <method name="FocusNextSameAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusPrevSameAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusNextOtherAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusPrevOtherAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusNextAnyAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusPrevAnyAppWindow">
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="ResizeById">
      <arg type="s" name="id" direction="in"/>
      <arg type="i" name="width" direction="in"/>
      <arg type="i" name="height" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="MoveToWorkspaceById">
      <arg type="s" name="id" direction="in"/>
      <arg type="i" name="index" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="SwitchWorkspace">
      <arg type="i" name="index" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="FocusByCls">
      <arg type="s" name="cls" direction="in"/>
      <arg type="i" name="code" direction="out"/>
    </method>
    <method name="LaunchHere">
      <arg type="s" name="path" direction="in"/>
      <arg type="s" name="appId" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
  </interface>
</node>`;

class WMCtrlLikeExtension {
    constructor() {
        this._nameId = 0;
        this._impl = null;
    }

    _toHexId(w) {
        // Prefer X11 window id when available (Xwayland)
        try {
            if (typeof w.get_xwindow === 'function') {
                const xid = w.get_xwindow();
                if (xid && xid !== 0)
                    return '0x' + Number(xid).toString(16);
            }
        } catch (e) {
            // ignore
        }

        // Wayland/native: use a stable sequence number
        let seq = 0;
        try {
            if (typeof w.get_stable_sequence === 'function')
                seq = w.get_stable_sequence();
            else if (typeof w.get_id === 'function')
                seq = w.get_id(); // fallback if present on this version
        } catch (e) {
            // ignore
        }

        if (!seq || seq === 0) {
            // Ultimate fallback: use object hash; not stable across sessions
            try { seq = Math.abs(w.hash()); } catch (e) { seq = Date.now(); }
        }

        return '0x' + Number(seq).toString(16);
    }

    _classInstance(w) {
        let inst = null;
        let cls = null;

        try { if (typeof w.get_wm_class_instance === 'function') inst = w.get_wm_class_instance(); } catch (e) {}
        try { if (typeof w.get_wm_class === 'function') cls = w.get_wm_class(); } catch (e) {}

        if (!inst || !cls) {
            // Wayland fallback: use Shell app id, e.g. org.gnome.Nautilus or code.desktop
            try {
                const tracker = Shell.WindowTracker.get_default();
                const app = tracker.get_window_app(w);
                if (app) {
                    const appId = app.get_id(); // may end with .desktop
                    if (!inst) inst = appId;
                    if (!cls) cls = appId;
                }
            } catch (e) {
                // ignore
            }
        }

        if (!inst) inst = 'unknown';
        if (!cls) cls = 'unknown';
        return String(inst).toLowerCase() + '.' + String(cls).toLowerCase();
    }

    _creationOrderKey(w) {
        // Prefer MetaWindow stable sequence which is monotonic with creation
        try {
            if (typeof w.get_stable_sequence === 'function') {
                const k = w.get_stable_sequence();
                if (k && k > 0) return Number(k);
            }
        } catch (e) {}

        // Fallback: MetaWindow internal id if available
        try {
            if (typeof w.get_id === 'function') {
                const k = w.get_id();
                if (k && k > 0) return Number(k);
            }
        } catch (e) {}

        // Last resort: derive from our hex id (XID or sequence)
        try {
            const hex = this._toHexId(w);
            if (hex && typeof hex === 'string') {
                const s = hex.startsWith('0x') ? hex.slice(2) : hex;
                const n = Number.parseInt(s, 16);
                if (!Number.isNaN(n)) return n;
            }
        } catch (e) {}

        return 0;
    }

    _workspaceIndex(w) {
        try {
            if (typeof w.is_on_all_workspaces === 'function' && w.is_on_all_workspaces())
                return -1;
        } catch (e) {}

        try {
            const ws = typeof w.get_workspace === 'function' ? w.get_workspace() : null;
            if (ws && typeof ws.index === 'function')
                return ws.index();
        } catch (e) {}

        return 0;
    }

    _activeWorkspaceIndex() {
        try {
            let ws = null;
            if (global.workspace_manager && typeof global.workspace_manager.get_active_workspace === 'function')
                ws = global.workspace_manager.get_active_workspace();
            else if (global.screen && typeof global.screen.get_active_workspace === 'function')
                ws = global.screen.get_active_workspace();

            if (ws && typeof ws.index === 'function')
                return ws.index();
        } catch (e) {}
        return 0;
    }

    _activeWindowId() {
        try {
            let w = null;
            try {
                if (global.display && typeof global.display.get_focus_window === 'function')
                    w = global.display.get_focus_window();
            } catch (e) {}
            try {
                if (!w && global.display && 'focus_window' in global.display)
                    w = global.display.focus_window;
            } catch (e) {}
            if (!w)
                return '';
            return this._toHexId(w);
        } catch (e) {
            return '';
        }
    }

    _isTasklistWindow(w) {
        try {
            // Exclude desktop/docks and skip_taskbar windows to better match wmctrl
            if (w.skip_taskbar)
                return false;

            if (typeof w.get_window_type === 'function') {
                const wt = w.get_window_type();
                if (wt === Meta.WindowType.DESKTOP || wt === Meta.WindowType.DOCK)
                    return false;
            }
        } catch (e) {}
        return true;
    }

    // Collect sorted window items for internal reuse
    _listWindowsItems() {
        const items = [];
        const actors = global.get_window_actors();

        for (let actor of actors) {
            const w = actor.meta_window;
            if (!w)
                continue;
            if (!this._isTasklistWindow(w))
                continue;

            const id = this._toHexId(w);
            const desk = this._workspaceIndex(w);
            const cls = this._classInstance(w);

            let title = '';
            try { title = w.get_title() || ''; } catch (e) {}

            // Determine creation order key; later-created windows should sort later
            const key = this._creationOrderKey(w);

            items.push({
                key,
                id,
                desk,
                cls,
                title,
            });
        }

        // Sort by creation order ascending (earlier first, later last)
        items.sort((a, b) => {
            if (a.key !== b.key) return a.key - b.key;
            // Deterministic tie-breakers to keep order stable across focus changes
            if (a.desk !== b.desk) return a.desk - b.desk;
            const cmpCls = String(a.cls).localeCompare(String(b.cls));
            if (cmpCls !== 0) return cmpCls;
            const cmpTitle = String(a.title).localeCompare(String(b.title));
            if (cmpTitle !== 0) return cmpTitle;
            return String(a.id).localeCompare(String(b.id));
        });

        return items;
    }

    // Adapter that preserves the original ListWindows output format
    _listWindows() {
        try {
            const items = this._listWindowsItems();
            return items.map(it => `${it.id} ${it.desk} ${it.cls} ${it.title}`);
        } catch (e) {
            return [];
        }
    }

    _listWindowsText() {
        try { return this._listWindows().join('\n'); } catch (e) { return ''; }
    }

    _normalizeIdString(id) {
        try {
            if (typeof id !== 'string')
                id = String(id);
            let s = id.trim().toLowerCase();
            if (s.startsWith('0x'))
                s = s.slice(2);
            const n = Number.parseInt(s, 16);
            if (Number.isNaN(n))
                return null;
            return '0x' + n.toString(16);
        } catch (e) {
            return null;
        }
    }

    _findWindowById(id) {
        const norm = this._normalizeIdString(id);
        if (!norm)
            return null;

        const actors = global.get_window_actors();
        for (let actor of actors) {
            const w = actor.meta_window;
            if (!w)
                continue;
            if (!this._isTasklistWindow(w))
                continue;
            const wid = this._toHexId(w);
            if (wid && String(wid).toLowerCase() === norm)
                return w;
        }
        return null;
    }

    _activateWindowById(id) {
        try {
            const w = this._findWindowById(id);
            if (!w)
                return false;

            // Determine an event timestamp for activation and workspace switching
            let timestamp = 0;
            try {
                if (global.display && typeof global.display.get_current_time_roundtrip === 'function')
                    timestamp = global.display.get_current_time_roundtrip();
                else if (Clutter && typeof Clutter.get_current_event_time === 'function')
                    timestamp = Clutter.get_current_event_time();
            } catch (e) {}

            // If the window lives on a different workspace, switch to it first
            try {
                const isSticky = (typeof w.is_on_all_workspaces === 'function') && w.is_on_all_workspaces();
                const ws = (typeof w.get_workspace === 'function') ? w.get_workspace() : null;

                if (!isSticky && ws) {
                    let activeWs = null;
                    try {
                        if (global.workspace_manager && typeof global.workspace_manager.get_active_workspace === 'function')
                            activeWs = global.workspace_manager.get_active_workspace();
                        else if (global.screen && typeof global.screen.get_active_workspace === 'function')
                            activeWs = global.screen.get_active_workspace();
                    } catch (e) {}

                    let needSwitch = false;
                    try {
                        if (activeWs && typeof activeWs.index === 'function' && typeof ws.index === 'function')
                            needSwitch = activeWs.index() !== ws.index();
                        else
                            needSwitch = activeWs !== ws; // fallback object compare
                    } catch (e) {}

                    if (needSwitch) {
                        try {
                            if (typeof ws.activate === 'function')
                                ws.activate(timestamp);
                            else if (global.display && typeof global.display.activate_workspace === 'function')
                                global.display.activate_workspace(ws, timestamp);
                        } catch (e) {
                            // ignore workspace switch failures; continue to try activation
                        }
                    }
                }
            } catch (e) {}

            // Ensure the window is not minimized
            try {
                if (typeof w.unminimize === 'function' && w.minimized)
                    w.unminimize();
            } catch (e) {}

            // Finally, focus/activate the window
            try {
                if (typeof w.activate === 'function')
                    w.activate(timestamp);
                else if (typeof w.activate_full === 'function')
                    w.activate_full(timestamp, global.get_current_time ? global.get_current_time() : 0);
                else
                    return false;
            } catch (e) {
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    _resizeWindowById(id, width, height) {
        try {
            const w = this._findWindowById(id);
            if (!w)
                return false;

            // Sanitize dimensions
            let ww = Number(width) | 0;
            let hh = Number(height) | 0;
            if (!(ww > 0 && hh > 0))
                return false;

            // Keep current position, change size
            let rect = null;
            try {
                if (typeof w.get_frame_rect === 'function')
                    rect = w.get_frame_rect();
            } catch (e) {}

            let x = 0, y = 0;
            if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
                x = rect.x;
                y = rect.y;
            }

            try {
                if (typeof w.unminimize === 'function' && w.minimized)
                    w.unminimize();
            } catch (e) {}

            try {
                if (typeof w.move_resize_frame === 'function') {
                    // user_op=true
                    w.move_resize_frame(true, x, y, ww, hh);
                    return true;
                }
            } catch (e) {
                return false;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    _moveWindowToWorkspaceById(id, index) {
        try {
            const w = this._findWindowById(id);
            if (!w)
                return false;

            // Resolve workspace by index
            let wm = null;
            try {
                if (global.workspace_manager)
                    wm = global.workspace_manager;
                else if (global.screen)
                    wm = global.screen;
            } catch (e) {}

            if (!wm)
                return false;

            const idx = Number(index) | 0;
            let ws = null;
            try {
                if (typeof wm.get_workspace_by_index === 'function')
                    ws = wm.get_workspace_by_index(idx);
                else if (typeof wm.get_workspace === 'function')
                    ws = wm.get_workspace(idx);
            } catch (e) {}

            if (!ws)
                return false;

            try {
                // If sticky, no-op; else move
                const isSticky = (typeof w.is_on_all_workspaces === 'function') && w.is_on_all_workspaces();
                if (isSticky)
                    return true;

                if (typeof w.change_workspace_by_index === 'function') {
                    w.change_workspace_by_index(idx, false);
                    return true;
                } else if (typeof w.change_workspace === 'function') {
                    w.change_workspace(ws);
                    return true;
                }
            } catch (e) {
                return false;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    _switchWorkspace(index) {
        try {
            let wm = null;
            try {
                if (global.workspace_manager)
                    wm = global.workspace_manager;
                else if (global.screen)
                    wm = global.screen;
            } catch (e) {}

            if (!wm)
                return false;

            const idx = Number(index) | 0;
            if (!(idx >= 0))
                return false;

            let ws = null;
            try {
                if (typeof wm.get_workspace_by_index === 'function')
                    ws = wm.get_workspace_by_index(idx);
                else if (typeof wm.get_workspace === 'function')
                    ws = wm.get_workspace(idx);
            } catch (e) {}

            if (!ws)
                return false;

            let timestamp = 0;
            try {
                if (global.display && typeof global.display.get_current_time_roundtrip === 'function')
                    timestamp = global.display.get_current_time_roundtrip();
                else if (Clutter && typeof Clutter.get_current_event_time === 'function')
                    timestamp = Clutter.get_current_event_time();
            } catch (e) {}

            try {
                if (typeof ws.activate === 'function') {
                    ws.activate(timestamp);
                    return true;
                } else if (global.display && typeof global.display.activate_workspace === 'function') {
                    global.display.activate_workspace(ws, timestamp);
                    return true;
                }
            } catch (e) {
                return false;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    _focusRelativeSameAppWindow(delta) {
        try {
            const wsIdx = this._activeWorkspaceIndex();
            const activeId = this._activeWindowId();
            if (!activeId)
                return false;

            // Determine active class
            let activeCls = null;
            const activeWin = this._findWindowById(activeId);
            if (activeWin)
                activeCls = this._classInstance(activeWin);

            // Reuse shared, sorted window collection
            const all = this._listWindowsItems();
            if (!Array.isArray(all) || all.length === 0)
                return false;

            if (!activeCls) {
                const found = all.find(it => String(it.id).toLowerCase() === String(activeId).toLowerCase());
                if (!found)
                    return false;
                activeCls = found.cls;
            }

            // Same app, same workspace (include sticky windows)
            const items = all.filter(it => it.cls === activeCls && (it.desk === wsIdx || it.desk === -1));
            if (items.length === 0)
                return false;

            // Find current index within the filtered list
            let idx = items.findIndex(it => String(it.id).toLowerCase() === String(activeId).toLowerCase());
            if (idx === -1)
                idx = (delta > 0) ? -1 : 0;

            // Circular wrap
            const len = items.length;
            let targetIndex = (len === 1) ? 0 : (idx + delta) % len;
            if (targetIndex < 0)
                targetIndex += len;

            const target = items[targetIndex];
            if (!target)
                return false;

            return this._activateWindowById(target.id);
        } catch (e) {
            return false;
        }
    }

    _focusNextSameAppWindow() {
        return this._focusRelativeSameAppWindow(+1);
    }

    _focusPrevSameAppWindow() {
        return this._focusRelativeSameAppWindow(-1);
    }

    _focusRelativeOtherAppWindow(delta) {
        try {
            const wsIdx = this._activeWorkspaceIndex();
            const activeId = this._activeWindowId();
            if (!activeId)
                return false;

            // Use shared, sorted window list
            const all = this._listWindowsItems();
            if (!Array.isArray(all) || all.length === 0)
                return false;

            // Determine class of the active window
            let activeCls = null;
            const activeFound = all.find(it => String(it.id).toLowerCase() === String(activeId).toLowerCase());
            if (activeFound) {
                activeCls = activeFound.cls;
            } else {
                const w = this._findWindowById(activeId);
                if (!w)
                    return false;
                activeCls = this._classInstance(w);
            }

            const COPYQ_CLS = 'copyq.copyq';

            // Consider only same-workspace (or sticky) items, in the same global order
            const inWs = all.filter(it => (it.desk === wsIdx || it.desk === -1));
            if (inWs.length === 0)
                return false;

            // Position relative to current active window within workspace list
            let idx = inWs.findIndex(it => String(it.id).toLowerCase() === String(activeId).toLowerCase());
            if (idx === -1)
                idx = (delta > 0) ? -1 : 0;

            const len = inWs.length;
            if (len === 1) {
                // Only one window visible in workspace; must be same as active or not usable
                const only = inWs[0];
                if (only && only.cls !== activeCls && only.cls !== COPYQ_CLS)
                    return this._activateWindowById(only.id);
                return false;
            }

            // Step through circularly to find the next/prev window of a different app, skipping CopyQ
            for (let step = 1; step <= len; step++) {
                let targetIndex = (idx + delta * step) % len;
                if (targetIndex < 0)
                    targetIndex += len;

                const cand = inWs[targetIndex];
                if (!cand)
                    continue;
                if (cand.cls === COPYQ_CLS)
                    continue;
                if (cand.cls === activeCls)
                    continue;

                return this._activateWindowById(cand.id);
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    _focusNextOtherAppWindow() {
        return this._focusRelativeOtherAppWindow(+1);
    }

    _focusPrevOtherAppWindow() {
        return this._focusRelativeOtherAppWindow(-1);
    }

    _focusRelativeAnyAppWindow(delta) {
        try {
            const wsIdx = this._activeWorkspaceIndex();
            const activeId = this._activeWindowId();
            if (!activeId)
                return false;

            const all = this._listWindowsItems();
            if (!Array.isArray(all) || all.length === 0)
                return false;

            const COPYQ_CLS = 'copyq.copyq';

            const inWs = all.filter(it => (it.desk === wsIdx || it.desk === -1));
            if (inWs.length === 0)
                return false;

            let idx = inWs.findIndex(it => String(it.id).toLowerCase() === String(activeId).toLowerCase());
            if (idx === -1)
                idx = (delta > 0) ? -1 : 0;

            const len = inWs.length;

            for (let step = 1; step <= len; step++) {
                let targetIndex = (idx + delta * step) % len;
                if (targetIndex < 0)
                    targetIndex += len;

                const cand = inWs[targetIndex];
                if (!cand)
                    continue;
                if (cand.cls === COPYQ_CLS)
                    continue;
                if (String(cand.id).toLowerCase() === String(activeId).toLowerCase())
                    continue;

                return this._activateWindowById(cand.id);
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    _focusNextAnyAppWindow() {
        return this._focusRelativeAnyAppWindow(+1);
    }

    _focusPrevAnyAppWindow() {
        return this._focusRelativeAnyAppWindow(-1);
    }

    // Focus window by class/appId with preference to current workspace.
    // Returns:
    //   0 = success (focused a matching window)
    //   1 = no match found
    //   2 = found match but activation failed (or unexpected error)
    _focusByCls(cls) {
        try {
            if (typeof cls !== 'string' || cls.trim() === '')
                return 1;

            const targetCls = String(cls).trim().toLowerCase();
            const all = this._listWindowsItems();
            if (!Array.isArray(all) || all.length === 0)
                return 1;

            const wsIdx = this._activeWorkspaceIndex();

            // exact match against our normalized cls field
            const matches = all.filter(it => String(it.cls).toLowerCase() === targetCls);
            if (matches.length === 0)
                return 1;

            // Prefer current workspace (including sticky)
            const inWs = matches.filter(it => (it.desk === wsIdx || it.desk === -1));
            const offWs = matches.filter(it => !(it.desk === wsIdx || it.desk === -1));

            const pick = (inWs.length > 0 ? inWs[0] : (offWs[0] || null));
            if (!pick)
                return 1;

            const ok = this._activateWindowById(pick.id);
            return ok ? 0 : 2;
        } catch (e) {
            return 2;
        }
    }

    _debugLog(msg) {
        const logPath = GLib.build_filenamev([GLib.get_tmp_dir(), 'wmctrllike.log']);
        const file = Gio.File.new_for_path(logPath);
        let stream;
        try {
            stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            stream = file.create(Gio.FileCreateFlags.NONE, null);
        }
        stream.write(`${new Date().toISOString()} [LaunchHere] ${msg}\n`, null);
        stream.close(null);
    }

    _launchHere(path, appId) {
        // this._debugLog(`Launching ${path} with appId ${appId}`);
        const currentItems = this._listWindowsItems();
        const maxKey = currentItems.length > 0 ? Math.max(...currentItems.map(it => it.key)) : 0;
        const performActions = (win) => {
            // this._debugLog(`New window detected: ${this._toHexId(win)} for ${appId}`);
            const currentWs = this._activeWorkspaceIndex();
            const winWs = this._workspaceIndex(win);
            if (winWs !== currentWs && winWs !== -1) {
                // this._debugLog(`Moving window to workspace ${currentWs}`);
                this._moveWindowToWorkspaceById(this._toHexId(win), currentWs);
            }
            // this._debugLog(`Activating window`);
            this._activateWindowById(this._toHexId(win));
            if (path.includes('/opt/kitty/linux-package/bin/kitty')) {
                const monitorIndex = global.display.get_current_monitor();
                const geometry = global.display.get_monitor_geometry(monitorIndex);
                const screenW = geometry.width;
                const screenH = geometry.height;
                const newW = Math.floor(screenW * 0.4);
                const newH = Math.floor(screenH * 0.5);
                // this._debugLog(`Scheduling resize for kitty to ${newW}x${newH}`);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    // this._debugLog(`Performing resize for kitty to ${newW}x${newH}`);
                    this._resizeWindowById(this._toHexId(win), newW, newH);
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
        try {
            GLib.spawn_command_line_async(path);
        } catch (e) {
            // this._debugLog(`Launch failed: ${e.message}`);
            return false;
        }
        const handlerId = global.display.connect('window-created', (display, win) => {
            const winCls = this._classInstance(win);
            const winKey = this._creationOrderKey(win);
            if (winCls === appId.toLowerCase() && winKey > maxKey) {
                performActions(win);
                global.display.disconnect(handlerId);
                GLib.source_remove(timeoutId);
            } else if (winKey > maxKey) {
                const notifyId = win.connect('notify::wm-class', () => {
                    const newCls = this._classInstance(win);
                    // this._debugLog(`WM_CLASS changed for ${this._toHexId(win)}: ${newCls}`);
                    if (newCls === appId.toLowerCase()) {
                        performActions(win);
                        global.display.disconnect(handlerId);
                        win.disconnect(notifyId);
                        GLib.source_remove(timeoutId);
                    }
                });
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    win.disconnect(notifyId);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            global.display.disconnect(handlerId);
            // this._debugLog(`Timeout: No new window for ${appId}`);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    enable() {
        const nodeInfo = Gio.DBusNodeInfo.new_for_xml(IFACE_XML);
        const ifaceInfo = nodeInfo.interfaces[0];

        this._impl = Gio.DBusExportedObject.wrapJSObject(ifaceInfo, {
            ListWindows: () => {
                return this._listWindowsText();
            },
            ActivateById: (id) => {
                return this._activateWindowById(id);
            },
            GetActiveWorkspace: () => {
                return String(this._activeWorkspaceIndex());
            },
            GetActiveWindow: () => {
                return this._activeWindowId();
            },
            ResizeById: (id, width, height) => {
                return this._resizeWindowById(id, width, height);
            },
            MoveToWorkspaceById: (id, index) => {
                return this._moveWindowToWorkspaceById(id, index);
            },
            SwitchWorkspace: (index) => {
                return this._switchWorkspace(index);
            },
            FocusNextSameAppWindow: () => {
                return this._focusNextSameAppWindow();
            },
            FocusPrevSameAppWindow: () => {
                return this._focusPrevSameAppWindow();
            },
            FocusNextOtherAppWindow: () => {
                return this._focusNextOtherAppWindow();
            },
            FocusPrevOtherAppWindow: () => {
                return this._focusPrevOtherAppWindow();
            },
            FocusNextAnyAppWindow: () => {
                return this._focusNextAnyAppWindow();
            },
            FocusPrevAnyAppWindow: () => {
                return this._focusPrevAnyAppWindow();
            },
            FocusByCls: (cls) => {
                return this._focusByCls(cls);
            },
            LaunchHere: (path, appId) => {
                return this._launchHere(path, appId);
            },
        });

        this._nameId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.gnome.Shell.Extensions.WMCtrl1',
            Gio.BusNameOwnerFlags.REPLACE,
            (connection /*, name */) => {
                try {
                    this._impl.export(connection, '/org/gnome/Shell/Extensions/WMCtrl1');
                } catch (e) {
                    logError(e, 'Failed to export D-Bus object');
                }
            },
            null,
            null
        );
    }

    disable() {
        if (this._impl) {
            try { this._impl.unexport(); } catch (e) {}
            this._impl = null;
        }
        if (this._nameId) {
            try { Gio.bus_unown_name(this._nameId); } catch (e) {}
            this._nameId = 0;
        }
    }
}

function init() {
    return new WMCtrlLikeExtension();
}
