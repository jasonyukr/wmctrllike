// SPDX-License-Identifier: MIT
'use strict';

const { Gio, Meta, Shell, Clutter } = imports.gi;
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

    _listWindows() {
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

        return items.map(it => `${it.id} ${it.desk} ${it.cls} ${it.title}`);
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
