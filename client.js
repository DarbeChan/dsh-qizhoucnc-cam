window.__ModuleLoader__.load({
  id: 'dsh-qizhoucnc-cam',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 「引用到对话框」所需：apply(ctx) 存下 root ctx，点击时惰性解析 conversation 服务
    // （ConversationController.input = InputHub）。立即加载时序下 apply 阶段该服务可能尚未就绪。
    let appCtx = null;

    // ============ dsh-resource://file 地址解码（与 DSH docpreview 同源语义） ============
    // 会话中蓝色文件名点击 → openFile → sidebarRight.openResource(dsh-resource://file/session/<id>/<path>)
    // 本插件注册更高优先级(extension)的 tab 类型接管 .nc/.cnc/.gcode，解码地址后在本插件编辑器打开。
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    function basenameOf(path) { return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path; }
    function isWindowsStylePath(value) { return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\'); }
    function isAbsoluteWorkspacePath(path) { return path.startsWith('/') || isWindowsStylePath(path); }
    function resolveWorkspacePath(cwd, path) {
      if (isAbsoluteWorkspacePath(path)) return path;
      if (cwd === undefined || cwd === '') return path;
      const separator = isWindowsStylePath(cwd) && cwd.includes('\\') ? '\\' : '/';
      return cwd.replace(/[/\\]+$/, '') + separator + path.replace(/^(?:\.?[/\\])+/, '');
    }
    function parseFileAddress(address) {
      try {
        if (!address || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/');
        if (scope === 'session') {
          const [id, ...segments] = rest;
          if (id === undefined || id === '' || segments.length === 0) return undefined;
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1;
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === '') return undefined;
          if (unc) return { scope, path: '//' + segments.join('/') };
          return { scope, path: /^[A-Za-z]:/.test(segments[0]) ? segments.join('/') : '/' + segments.join('/') };
        }
        return undefined;
      } catch (e) { return undefined; }
    }

    // ============ 3D projection (yaw around Z, then pitch around X) ============
    function project3d(p, yaw, pitch) {
      const [x, y, z] = p;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const y2 = y1 * cp + z * sp;
      return [x1, -y2]; // screen: X right, Y up (CNC Z-up)
    }

    // six standard views + isometric default
    const VIEWS = [
      { id: 'iso', label: '等轴', yaw: 0.7, pitch: 0.55 },
      { id: 'top', label: '俯', yaw: 0, pitch: 0 },
      { id: 'front', label: '前', yaw: 0, pitch: Math.PI / 2 },
      { id: 'right', label: '右', yaw: -Math.PI / 2, pitch: Math.PI / 2 },
      { id: 'back', label: '后', yaw: Math.PI, pitch: Math.PI / 2 },
      { id: 'left', label: '左', yaw: Math.PI / 2, pitch: Math.PI / 2 },
      { id: 'bottom', label: '仰', yaw: 0, pitch: Math.PI },
    ];

    function computeBounds(data) {
      if (!data || !data.paths || data.paths.length === 0) return null;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const path of data.paths) for (const p of path.points) {
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
      }
      return { min, max };
    }

    function Chevron({ dir, size = 16 }) {
      const d = dir === 'left' ? 'M10 4 L4 12 L10 20' : 'M6 4 L12 12 L6 20';
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d }));
    }
    function IconCnc({ size = 16 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M12 3v18M3 12h18M7 6l10 12M17 6L7 18' }));
    }

    // ============ 3D viewer: always-on, rotate/pan/zoom + 6-face views ============
    function Viewer3D({ data }) {
      const [view, setView] = React.useState({ yaw: 0.7, pitch: 0.55, panX: 0, panY: 0, zoom: 1 });
      const drag = React.useRef(null);
      const W = 600, H = 460, cx = W / 2, cy = H / 2;

      const toScreen = React.useCallback((p) => {
        const [sx, sy] = project3d(p, view.yaw, view.pitch);
        return [cx + sx * view.zoom + view.panX, cy + sy * view.zoom + view.panY];
      }, [view]);

      const bounds = computeBounds(data);
      // grid/axes extent
      let R = 50;
      if (bounds) {
        const sx = (bounds.max[0] - bounds.min[0]) / 2;
        const sy = (bounds.max[1] - bounds.min[1]) / 2;
        const sz = (bounds.max[2] - bounds.min[2]) / 2;
        R = Math.max(sx, sy, sz, 10) * 1.2;
      }

      // grid on the XY plane at z = minZ (or 0)
      const baseZ = bounds ? bounds.min[2] : 0;
      const step = Math.max(1, Math.round(R / 5));
      const gridLines = [];
      for (let v = -R; v <= R + 1e-9; v += step) {
        gridLines.push([[-R, v, baseZ], [R, v, baseZ]]);
        gridLines.push([[v, -R, baseZ], [v, R, baseZ]]);
      }
      // axes
      const axLen = R * 1.1;
      const axes = [
        { pts: [[0, 0, baseZ], [axLen, 0, baseZ]], color: 'var(--dsw-alias-state-error-primary, #ef4444)' }, // X
        { pts: [[0, 0, baseZ], [0, axLen, baseZ]], color: 'var(--dsw-alias-state-success-primary, #22c55e)' }, // Y
        { pts: [[0, 0, baseZ], [0, 0, baseZ + axLen]], color: 'var(--dsw-alias-state-business-primary, #3b82f6)' }, // Z
      ];

      const line = (pts, color, width, dash) => {
        let d = '';
        pts.forEach((p, j) => {
          const [sx, sy] = toScreen(p);
          d += (j === 0 ? 'M' : 'L') + sx.toFixed(1) + ' ' + sy.toFixed(1);
        });
        return h('path', { d, fill: 'none', stroke: color, strokeWidth: width, strokeDasharray: dash, strokeLinejoin: 'round', strokeLinecap: 'round' });
      };

      // toolpath polylines
      const pathsEl = (data && data.paths) ? data.paths.map((path, i) => line(
        path.points,
        path.cut ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-label-tertiary, #9ca3af)',
        path.cut ? 1.8 : 1,
        path.cut ? undefined : '3 3',
      )) : [];

      const onPointerDown = (e) => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          x: e.clientX, y: e.clientY,
          yaw: view.yaw, pitch: view.pitch, panX: view.panX, panY: view.panY,
          mode: (e.button === 2 || e.shiftKey) ? 'pan' : 'rotate',
        };
      };
      const onPointerMove = (e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (d.mode === 'pan') {
          setView((v) => ({ ...v, panX: d.panX + dx, panY: d.panY + dy }));
        } else {
          setView((v) => ({
            ...v,
            yaw: d.yaw + dx * 0.01,
            pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, d.pitch + dy * 0.01)),
          }));
        }
      };
      const onPointerUp = () => { drag.current = null; };
      const onWheel = (e) => {
        e.preventDefault();
        setView((v) => ({ ...v, zoom: Math.max(0.05, Math.min(20, v.zoom * (e.deltaY < 0 ? 1.12 : 0.9))) }));
      };
      // compute a zoom that fits all toolpath points for a given yaw/pitch
      const fitView = (yaw, pitch) => {
        if (!bounds) return { yaw, pitch, panX: 0, panY: 0, zoom: 1 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const path of data.paths) for (const p of path.points) {
          const [x, y] = project3d(p, yaw, pitch);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const w = maxX - minX, h = maxY - minY;
        const zoom = Math.min((W - 40) / Math.max(1e-6, w), (H - 40) / Math.max(1e-6, h));
        return { yaw, pitch, panX: 0, panY: 0, zoom: Math.max(0.05, Math.min(20, zoom)) };
      };
      const applyView = (v) => setView((cur) => fitView(v.yaw, v.pitch));

      const viewBtn = (v, active) => h('button', {
        key: v.id, onClick: () => applyView(v), title: v.label + '视图',
        style: {
          padding: '1px 6px', fontSize: 11, cursor: 'pointer', borderRadius: 5,
          border: '1px solid ' + (active ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)'),
          background: active ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 12%, transparent)' : 'transparent',
          color: 'var(--dsw-alias-label-primary, #111)',
        },
      }, v.label);

      const activeView = VIEWS.find((v) => Math.abs(v.yaw - view.yaw) < 1e-6 && Math.abs(v.pitch - view.pitch) < 1e-6);

      // fixed axis gizmo (bottom-left corner), rotates with the view only
      const gzOrigin = [40, H - 42];
      const gzLen = 26;
      const gzColors = {
        x: 'var(--dsw-alias-state-error-primary, #ef4444)',
        y: 'var(--dsw-alias-state-success-primary, #22c55e)',
        z: 'var(--dsw-alias-state-business-primary, #3b82f6)',
      };
      const gzDir = (v3) => {
        const [x, y] = project3d(v3, view.yaw, view.pitch);
        const len = Math.hypot(x, y);
        return len < 1e-6 ? null : [x / len, y / len];
      };
      const gizmo = [
        { key: 'x', dir: gzDir([1, 0, 0]), color: gzColors.x, label: 'X' },
        { key: 'y', dir: gzDir([0, 1, 0]), color: gzColors.y, label: 'Y' },
        { key: 'z', dir: gzDir([0, 0, 1]), color: gzColors.z, label: 'Z' },
      ];
      const gizmoEls = gizmo.map((g) => {
        if (!g.dir) {
          // axis pointing straight at the screen: draw a dot at the origin
          return h('g', { key: g.key },
            h('circle', { cx: gzOrigin[0], cy: gzOrigin[1], r: 3, fill: g.color }),
            h('text', { x: gzOrigin[0] + 8, y: gzOrigin[1] + 4, fontSize: 10, fontWeight: 700, fill: g.color, textAnchor: 'middle', dominantBaseline: 'middle' }, g.label));
        }
        const end = [gzOrigin[0] + g.dir[0] * gzLen, gzOrigin[1] + g.dir[1] * gzLen];
        return h('g', { key: g.key },
          h('line', { x1: gzOrigin[0], y1: gzOrigin[1], x2: end[0], y2: end[1], stroke: g.color, strokeWidth: 2, strokeLinecap: 'round' }),
          h('circle', { cx: end[0], cy: end[1], r: 3, fill: g.color }),
          h('text', { x: end[0] + g.dir[0] * 6, y: end[1] + g.dir[1] * 6, fontSize: 10, fontWeight: 700, fill: g.color, textAnchor: 'middle', dominantBaseline: 'middle' }, g.label),
        );
      });

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 } },
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', marginRight: 2 } }, '视图'),
          VIEWS.map((v) => viewBtn(v, activeView === v)),
          h('button', { style: { marginLeft: 'auto', padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)' }, onClick: () => setView(fitView(0.7, 0.55)), title: '重置视图并适配' }, '重置')),
        h('svg', {
          viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: '100%',
          style: { background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', touchAction: 'none', cursor: 'grab', flex: 1, minHeight: 0 },
          onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
          onWheel, onContextMenu: (e) => e.preventDefault(),
        },
          gridLines.map((g, i) => line(g, 'var(--dsw-alias-border-l1, #e5e7eb)', 0.5)),
          axes.map((a, i) => line(a.pts, a.color, 1.2)),
          pathsEl,
          h('g', { pointerEvents: 'none' }, gizmoEls),
          (!data || !data.paths || data.paths.length === 0) && h('text', {
            x: cx, y: cy, textAnchor: 'middle', fontSize: 13, fill: 'var(--dsw-alias-label-tertiary, #9ca3af)',
          }, '暂无刀路 — 点选下方 NC 文件自动生成')),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
          '拖拽=旋转 · Shift+拖拽/右键=平移 · 滚轮=缩放 · ' + (data && data.file ? '文件: ' + data.file + ' · ' : '') + (data ? data.paths.length + ' 段' : '')),
      );
    }

    // ============ NC 编辑器（大界面：预览 + 修改） ============
    const ED_HEAD = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)' };
    const edBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600, borderRadius: 6, border: '1px solid transparent' };
    const edBtnGhost = { ...edBtn, fontWeight: 400, background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' };
    const edBtnPrimary = { ...edBtn, background: 'var(--dsw-alias-bg-layer-2, #eef2f6)', color: 'var(--dsw-alias-label-primary, #111)', border: '1px solid var(--dsw-alias-brand-primary, #2563eb)' };
    const edBtnDanger = { ...edBtn, fontWeight: 400, background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #dc2626)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' };
    const edTextarea = {
      flex: 1, minHeight: 0, resize: 'none', padding: '12px 14px',
      fontFamily: 'var(--dsw-alias-font-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      fontSize: 13.5, lineHeight: 1.6, tabSize: 2,
      border: 'none', outline: 'none', background: 'var(--dsw-alias-bg-layer-1, #fff)',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)', whiteSpace: 'pre', overflow: 'auto',
      WebkitTextSizeAdjust: '100%',
    };

    // React error boundary: catches any render crash inside the editor and shows the
    // message inline instead of letting the whole slot go blank.
    class NcEditorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
          return h('div', { style: { padding: 16, color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
            '编辑器渲染错误：' + msg);
        }
        return this.props.children;
      }
    }

    function NcEditor({ file, sessionId, version, onClose, onViewToolpath }) {
      const [text, setText] = React.useState('');
      const [loaded, setLoaded] = React.useState(false);
      const [err, setErr] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [savedAt, setSavedAt] = React.useState(null);
      const [menu, setMenu] = React.useState(null); // { x, y, sel, startLine, endLine }
      const taRef = React.useRef(null);

      const post = React.useCallback((path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()), []);

      // 选中代码 → 引用进 DSH 对话框，方便模型快速定位
      // 服务在点击时惰性解析：apply 阶段 conversation 服务可能尚未就绪（立即加载时序）。
      const resolveInputHub = () => {
        if (!appCtx) return null;
        try {
          const conv = appCtx.get('conversation');
          if (conv && conv.input && typeof conv.input.shell === 'function') return conv.input;
        } catch (e) { /* 未就绪，走下一路径 */ }
        try {
          const sessions = appCtx.get('sessions');
          if (sessions && typeof sessions.scope === 'function' && sessionId) {
            const actx = sessions.scope(sessionId);
            if (actx) {
              const conv = actx.get('conversation');
              if (conv && conv.input && typeof conv.input.shell === 'function') return conv.input;
            }
          }
        } catch (e) { /* 忽略 */ }
        return null;
      };

      // 把一段选中代码引用进 DSH 对话框（共享：右键菜单与兜底按钮都走这里）
      const doQuote = (sel, startLine, endLine) => {
        const quote = '【NC 程序引用】' + (file || '') + '\n第 ' + startLine + '-' + endLine + ' 行：\n' + sel;
        const inputHub = resolveInputHub();
        if (!inputHub || typeof inputHub.shell !== 'function') {
          setErr('对话框服务未就绪，无法引用'); return false;
        }
        try {
          const shell = inputHub.shell(sessionId);
          if (!shell) { setErr('未能定位到当前会话的输入框'); return false; }
          let ok = false;
          if (typeof shell.insertQuote === 'function') ok = shell.insertQuote(quote);
          if (!ok && typeof shell.setDraft === 'function') { shell.setDraft(quote); ok = true; }
          if (!ok) setErr('引用失败：当前输入框不可编辑');
          return ok;
        } catch (e) { setErr('引用失败：' + (e && e.message ? e.message : String(e))); return false; }
      };

      // 右键在选中代码上弹出自定义菜单（替换原生右键菜单）
      const onContextMenu = (e) => {
        e.preventDefault();
        const ta = taRef.current;
        if (!ta) return;
        const start = ta.selectionStart, end = ta.selectionEnd;
        if (start === end) { setErr('请先选中要引用的代码'); setMenu(null); return; }
        const sel = text.slice(start, end);
        if (!sel.trim()) { setErr('选中的内容为空'); setMenu(null); return; }
        setMenu({
          x: e.clientX, y: e.clientY, sel,
          startLine: text.slice(0, start).split('\n').length,
          endLine: text.slice(0, end).split('\n').length,
        });
      };

      React.useEffect(() => {
        if (!file) return;
        setErr(null); setLoaded(false); setSavedAt(null);
        fetch('/dsh-cam/nc?file=' + encodeURIComponent(file)).then((r) => r.json()).then((d) => {
          if (d.ok) { setText(d.content ?? ''); setLoaded(true); }
          else setErr(d.error || '读取失败');
        }).catch((e) => setErr(String(e)));
      }, [file, version]);

      const save = () => {
        if (!file || !loaded) return;
        setBusy(true); setErr(null);
        post('/dsh-cam/save', { file, content: text })
          .then((d) => {
            if (d.ok) { setSavedAt(new Date().toLocaleTimeString()); setErr(null); }
            else setErr(d.error || '保存失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      };

      // 保存当前编辑（若有改动）后，跳转到该 NC 文件对应的刀路视图
      const viewToolpath = () => {
        setBusy(true); setErr(null);
        const finish = () => {
          if (typeof onViewToolpath === 'function') onViewToolpath();
          else if (typeof onClose === 'function') onClose();
        };
        if (file && loaded) {
          post('/dsh-cam/save', { file, content: text })
            .then((d) => {
              if (d.ok) { setSavedAt(new Date().toLocaleTimeString()); finish(); }
              else { setErr(d.error || '保存失败'); setBusy(false); }
            })
            .catch((e) => { setErr(String(e)); setBusy(false); });
        } else {
          finish();
        }
      };

      const onKey = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      };

      const lineCount = text ? text.split('\n').length : 0;

      return h('div', { style: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)' } },
        h('div', { style: ED_HEAD },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: file },
            '编辑 NC：' + (file || '')),
          savedAt ? h('span', { style: { fontSize: 12, fontWeight: 600, color: '#ffffff', background: '#16a34a', padding: '2px 10px', borderRadius: 10, flex: 'none', lineHeight: '18px' } }, '✓ 已保存 ' + savedAt) : null,
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', flex: 'none' } }, lineCount + ' 行'),
          h('button', { style: edBtnPrimary, onClick: save, disabled: busy || !loaded, title: '保存并刷新刀路 (⌘S)' }, busy ? '保存中…' : '保存'),
          h('button', { style: edBtnGhost, onClick: viewToolpath, disabled: busy, title: '查看该 NC 文件对应的刀路' }, '查看刀路'),
          h('button', { style: edBtnDanger, onClick: onClose, title: '返回刀路视图' }, '返回')),
        err ? h('div', { style: { padding: '8px 14px', color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12, borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)' } }, '错误：' + err) : null,
        h('textarea', {
          ref: taRef, style: edTextarea, value: text, spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off',
          placeholder: loaded ? '' : '加载中…',
          onChange: (e) => setText(e.target.value), onKeyDown: onKey, onContextMenu: onContextMenu,
        }),
        menu ? h('div', {
          style: {
            position: 'fixed', left: menu.x, top: menu.y, zIndex: 1200, minWidth: 160,
            background: 'var(--dsw-alias-bg-overlay, #fff)', color: 'var(--dsw-alias-label-primary, #111)',
            border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', borderRadius: 8, padding: 4,
            boxShadow: '0 8px 24px -6px rgba(16,24,40,0.24)',
          },
          onMouseLeave: () => setMenu(null),
        },
          h('button', {
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
              fontSize: 13, cursor: 'pointer', border: 'none', borderRadius: 6,
              background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)',
            },
            onClick: () => { doQuote(menu.sel, menu.startLine, menu.endLine); setMenu(null); },
          }, '引用到对话框')) : null);
    }

    // ============ 右栏 tab 类型：接管会话中蓝色 .nc 文件名的点击（feature 4） ============
    // DSH 蓝色文件名点击默认由 kind="text"(fallback) 预览；这里注册 priority="extension" 的
    // 类型，用更精确的 NC 扩展名 patterns 抢在 fallback 之前认领，把编辑器搬进右栏 tab。
    const NC_TAB_TYPE_ID = 'dsh-cam-toolpath-tab';
    const NC_TAB_KIND = 'nc-toolpath';

    function NcToolpathTab({ useTabInfo, useSessions }) {
      const { tab, actions } = useTabInfo();
      const sessions = useSessions ? useSessions((s) => s) : null;
      const parsed = React.useMemo(() => parseFileAddress(tab.contentId), [tab.contentId]);
      const byId = sessions && sessions.byId ? sessions.byId : {};
      const sessionId = parsed && parsed.scope === 'session' ? parsed.sessionId : null;
      const cwd = sessionId && byId[sessionId] ? (byId[sessionId].cwd || null) : null;
      const file = React.useMemo(() => {
        if (!parsed) return null;
        return resolveWorkspacePath(cwd || '', parsed.path);
      }, [parsed, cwd]);

      if (!parsed || !file) {
        return h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 13 } },
          '无法解析该 NC 文件地址');
      }
      const closeTab = () => { try { if (actions && typeof actions.close === 'function') actions.close(); } catch (e) { /* ignore */ } };
      return h(NcEditorBoundary, null,
        h(NcEditor, { file, sessionId, version: 0, onClose: closeTab }));
    }

    // ============ floating panel ============
    const ROOT = { position: 'absolute', inset: 0, pointerEvents: 'none' };
    const PANEL = {
      position: 'absolute', top: 'var(--dsh-windows-titlebar-height, 0px)', right: 0, bottom: 0,
      width: 760, maxWidth: '94vw', pointerEvents: 'auto',
      display: 'flex', flexDirection: 'column', minWidth: 0,
      background: 'var(--dsw-alias-bg-base, #fff)',
      borderLeft: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
      boxShadow: '-16px 0 28px -20px rgba(16,24,40,0.18)',
      WebkitAppRegion: 'no-drag',
    };
    // collapse handle INSIDE the panel, on its LEFT edge, vertical center
    const HANDLE_LEFT = {
      position: 'absolute', left: 0, top: '50%', transform: 'translate(-100%, -50%)',
      pointerEvents: 'auto', cursor: 'pointer', zIndex: 900,
      display: 'flex', alignItems: 'center', gap: 3,
      border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
      borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
      background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111)',
      padding: '6px 4px', boxShadow: '-2px 0 6px -3px rgba(16,24,40,0.25)',
    };
    // resize handle INSIDE the panel, on its LEFT edge, full height — drag to resize width
    const RESIZE_HANDLE = {
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 8,
      cursor: 'col-resize', zIndex: 901, pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    const RESIZE_HANDLE_BAR = {
      width: 3, height: '42%', borderRadius: 2,
      background: 'var(--dsw-alias-border-l2, #d1d5db)',
      opacity: 0.5, transition: 'opacity .15s',
    };
    // expand handle on the screen RIGHT edge (collapsed state)
    const HANDLE_RIGHT = {
      position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
      pointerEvents: 'auto', cursor: 'pointer', zIndex: 900,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', borderRight: 'none',
      borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
      background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #111)',
      padding: '8px 5px', boxShadow: '2px 0 6px -3px rgba(16,24,40,0.25)',
    };
    const BADGE = {
      minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
      background: 'var(--dsw-alias-state-business-primary, #2563eb)', color: '#fff',
      fontSize: 11, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    };
    const btn = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'var(--dsw-alias-interactive-bg, transparent)', color: 'var(--dsw-alias-label-primary, #111)' };
    const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600, borderRadius: 6, border: '1px solid transparent', background: 'var(--dsw-alias-state-business-primary, #2563eb)', color: '#fff' };
    const input = { flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', borderRadius: 6, background: 'var(--dsw-alias-surface, #fff)', color: 'var(--dsw-alias-label-primary, #111)' };

    function ToolpathPanel({ useSessions }) {
      const [open, setOpen] = React.useState(true);
      const [data, setData] = React.useState(null);
      const [files, setFiles] = React.useState({ nc: [], steps: [] });
      const [err, setErr] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [activeFile, setActiveFile] = React.useState(null);
      const [modelFile, setModelFile] = React.useState('');
      const [pickedDirs, setPickedDirs] = React.useState([]);
      const [errors, setErrors] = React.useState({}); // filePath -> error message
      const [listExpanded, setListExpanded] = React.useState(false);
      const [diagCwd, setDiagCwd] = React.useState(null);
      const [editingFile, setEditingFile] = React.useState(null);
      // feature 2: force NcEditor to re-fetch when the underlying NC file changed on disk
      const [editVersion, setEditVersion] = React.useState(0);
      // feature 3: NC files the model just modified (surfaced for a quick jump)
      const [changedNc, setChangedNc] = React.useState([]);
      const panelRef = React.useRef(null);
      // 可拖拽调节的面板宽度（像素），持久化到 localStorage
      const [panelWidth, setPanelWidth] = React.useState(() => {
        try {
          const saved = globalThis.localStorage?.getItem('dsh-cam-panel-width');
          const n = saved ? parseInt(saved, 10) : NaN;
          if (Number.isFinite(n) && n >= 360 && n <= 1400) return n;
        } catch { /* ignore */ }
        return 760;
      });
      const dragging = React.useRef(null);
      const startResize = React.useCallback((e) => {
        e.preventDefault();
        dragging.current = { startX: e.clientX, startW: panelWidth };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }, [panelWidth]);
      React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const onMove = (e) => {
          const d = dragging.current;
          if (!d) return;
          // 面板靠右，向左拖（clientX 减小）则变宽
          const w = Math.min(1400, Math.max(360, d.startW + (d.startX - e.clientX)));
          setPanelWidth(w);
        };
        const onUp = () => {
          if (!dragging.current) return;
          dragging.current = null;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          setPanelWidth((w) => { try { globalThis.localStorage?.setItem('dsh-cam-panel-width', String(Math.round(w))); } catch { /* ignore */ } return w; });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
      }, []);

      const sessionList = useSessions ? useSessions((s) => s) : null;
      const byId = sessionList?.byId ?? {};
      // 当前主视图会话：retainedBy.mainView > 0 的那一行（与 uiSession.publishMain 同源判定）
      const mainId = Object.values(byId).find((row) => row && (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null;
      const session = mainId ? byId[mainId] : null;
      const sessionId = mainId;
      const sessionCwd = (typeof session?.cwd === 'string') ? session.cwd : null;

      const load = React.useCallback(() => {
        fetch('/dsh-cam/toolpath').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((d) => { setData(d); setErr(null); setActiveFile(d.file || null); })
          .catch((e) => setErr(String(e)));
      }, []);
      const loadFiles = React.useCallback(() => {
        const params = [];
        if (sessionId) params.push('session=' + encodeURIComponent(sessionId));
        if (sessionCwd) params.push('root=' + encodeURIComponent(sessionCwd));
        for (const d of pickedDirs) params.push('root=' + encodeURIComponent(d));
        fetch('/dsh-cam/files' + (params.length ? '?' + params.join('&') : '')).then((r) => r.json()).then((d) => {
          if (d.ok) { setFiles({ nc: d.nc || [], steps: d.steps || [] }); setDiagCwd(d.sessionCwd ?? null); }
        }).catch(() => {});
      }, [sessionId, sessionCwd, pickedDirs]);

      // feature 3: poll the changed-NC endpoint (host accumulates workspace-changes summaries)
      const loadChangedNc = React.useCallback(() => {
        if (!sessionId) return;
        fetch('/dsh-cam/changed' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''))
          .then((r) => r.json())
          .then((d) => { if (d.ok && Array.isArray(d.files) && d.files.length) setChangedNc(d.files); })
          .catch(() => {});
      }, [sessionId]);

      // feature 2: watch the currently open/active NC file for on-disk changes (AI edits)
      React.useEffect(() => {
        const target = editingFile || activeFile;
        if (!target) return;
        let stop = false;
        let last = '';
        const poll = async () => {
          try {
            const r = await fetch('/dsh-cam/nc?file=' + encodeURIComponent(target) + '&t=' + Date.now());
            const d = await r.json();
            if (!stop && d.ok && typeof d.content === 'string') {
              if (last !== '' && last !== d.content) setEditVersion((v) => v + 1);
              last = d.content;
            }
          } catch { /* ignore */ }
        };
        poll();
        const t = setInterval(poll, 2000);
        return () => { stop = true; clearInterval(t); };
      }, [editingFile, activeFile]);
      React.useEffect(() => { load(); loadFiles(); }, [load, loadFiles]);
      React.useEffect(() => {
        loadChangedNc();
        const t = setInterval(loadChangedNc, 3000);
        return () => clearInterval(t);
      }, [loadChangedNc]);

      const post = React.useCallback((path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()), []);

      const reveal = React.useCallback((filePath) => {
        post('/dsh-cam/reveal', { file: filePath }).then((d) => { if (!d.ok) setErr(d.error || '打开失败'); }).catch((e) => setErr(String(e)));
      }, [post]);

      // choose a directory via the native picker, then add its NC/STEP files to the list
      const pickDirectory = React.useCallback(async () => {
        try {
          const picker = globalThis.__DSH_DIRECTORY_PICKER__;
          const dir = picker ? await picker.pick() : null;
          if (typeof dir === 'string' && dir) {
            setPickedDirs((prev) => prev.includes(dir) ? prev : [...prev, dir]);
          }
        } catch (e) { setErr(String(e && e.message ? e.message : e)); }
      }, []);

      const loadNc = React.useCallback((filePath) => {
        setBusy(true);
        setErrors((prev) => { const n = { ...prev }; delete n[filePath]; return n; });
        post('/dsh-cam/toolpath', { file: filePath })
          .then((d) => {
            if (d.ok) {
              setErr(null);
              load(); loadFiles();
            } else {
              const msg = d.error || '处理失败';
              setErr(msg);
              setErrors((prev) => ({ ...prev, [filePath]: msg }));
            }
          })
          .catch((e) => {
            const msg = String(e);
            setErr(msg);
            setErrors((prev) => ({ ...prev, [filePath]: msg }));
          })
          .finally(() => setBusy(false));
      }, [post, load, loadFiles]);

      const generate = React.useCallback(() => {
        if (!modelFile.trim()) { setErr('请先输入模型(.step/.stp)路径'); return; }
        setBusy(true); setErr(null);
        post('/dsh-cam/generate', { model: modelFile.trim() })
          .then((d) => { if (d.ok) { load(); loadFiles(); } else setErr(d.error || '生成失败'); })
          .catch((e) => setErr(String(e))).finally(() => setBusy(false));
      }, [modelFile, post, load, loadFiles]);

      const ncCount = files.nc.length;

      // feature 1: clicking anywhere outside the panel collapses it to the right sidebar
      React.useEffect(() => {
        if (!open) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const onDown = (e) => {
          const node = panelRef.current;
          if (!node) return;
          // ignore clicks on anything inside the panel or the resize/handle subtree
          if (node.contains(e.target)) return;
          setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
      }, [open]);

      if (!open) {
        return h('div', { style: ROOT },
          h('button', { style: HANDLE_RIGHT, onClick: () => setOpen(true), title: '展开 CNC 刀路' },
            h('span', { style: { writingMode: 'vertical-rl', letterSpacing: 2, fontSize: 12, fontWeight: 600, lineHeight: '14px' } }, 'QizhouCNC_CAM'),
            h(Chevron, { dir: 'left', size: 14 }),
            ncCount > 0 ? h('span', { style: BADGE }, String(ncCount)) : null));
      }

      const fileItems = files.nc.map((f) => {
        const active = activeFile === f.path;
        return h('div', {
          key: f.name + f.path, title: f.path,
          style: {
            display: 'flex', alignItems: 'center', gap: 2, width: '100%',
            border: active ? '1px solid var(--dsw-alias-state-business-primary, #2563eb)' : '1px solid transparent',
            borderRadius: 6,
            background: active ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 8%, transparent)' : 'transparent',
          },
        },
          h('button', {
            onClick: () => loadNc(f.path),
            onDoubleClick: () => setEditingFile(f.path),
            style: {
              display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, textAlign: 'left',
              padding: '5px 8px', fontSize: 12, cursor: 'pointer',
              border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)',
            },
          },
            h(IconCnc, { size: 13 }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
            f.preferred ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-state-business-primary, #2563eb)', flex: 'none' }, title: '当前会话工作区' }, '●') : null),
          errors[f.path] ? h('button', {
            onClick: () => setErr(errors[f.path]), title: '处理出错，点击查看错误',
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
              width: 20, height: 20, padding: 0, cursor: 'pointer',
              border: 'none', background: 'transparent', borderRadius: 5,
              color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 13, fontWeight: 700,
            },
          }, '✗') : null,
          h('button', {
            onClick: () => setEditingFile(f.path), title: '编辑 NC 文件（预览 + 修改）',
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
              width: 24, height: 24, padding: 0, cursor: 'pointer',
              border: 'none', background: 'transparent', borderRadius: 5,
              color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 13,
            },
          }, '✎'),
          h('button', {
            onClick: () => reveal(f.path), title: '打开文件所在位置',
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
              width: 24, height: 24, padding: 0, cursor: 'pointer',
              border: 'none', background: 'transparent', borderRadius: 5,
              color: 'var(--dsw-alias-label-tertiary, #9ca3af)', fontSize: 13,
            },
          }, '⤴'));
      });
      const stepItems = files.steps.map((f) => h('div', {
        key: f.name + f.path, title: f.path,
        style: { display: 'flex', alignItems: 'center', gap: 2, width: '100%', border: '1px solid transparent', borderRadius: 6 },
      },
        h('button', {
          onClick: () => setModelFile(f.path),
          style: {
            display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, textAlign: 'left',
            padding: '5px 8px', fontSize: 12, cursor: 'pointer',
            border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)',
          },
        },
          h('span', { style: { fontSize: 13 } }, '🧊'),
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name)),
        h('button', {
          onClick: () => reveal(f.path), title: '打开文件所在位置',
          style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
            width: 24, height: 24, padding: 0, cursor: 'pointer',
            border: 'none', background: 'transparent', borderRadius: 5,
            color: 'var(--dsw-alias-label-tertiary, #9ca3af)', fontSize: 13,
          },
        }, '⤴')));

      return h('div', { style: ROOT, 'data-dsh-cam-overlay': '' },
        h('div', { style: { ...PANEL, width: panelWidth }, 'data-dsh-cam-panel': '', ref: panelRef },
          h('div', {
            style: RESIZE_HANDLE,
            onPointerDown: startResize,
            title: '拖动调节面板宽度',
            'aria-label': '拖动调节面板宽度',
          }, h('span', { style: RESIZE_HANDLE_BAR })),
          h('button', { style: HANDLE_LEFT, onClick: () => setOpen(false), title: '收起面板', 'aria-label': '收起面板' },
            h(Chevron, { dir: 'right', size: 14 })),
          editingFile
            ? h(NcEditorBoundary, null, h(NcEditor, {
              file: editingFile, sessionId, version: editVersion,
              onClose: () => { setEditingFile(null); load(); loadFiles(); },
              onViewToolpath: () => { setEditingFile(null); loadNc(editingFile); },
            }))
            : h(React.Fragment, null,
          h('div', { style: { padding: '10px 12px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
              h('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #6b7280)', flex: 1 } },
                'NC 文件' + (ncCount > 0 ? '（' + ncCount + '）' : '')),
              ncCount > 0 ? h('span', { style: BADGE, title: ncCount + ' 个 NC 文件' }, String(ncCount)) : null,
              h('button', { style: btn, onClick: pickDirectory, title: '选择文件夹，扫描其中的 NC 文件' }, '选择路径'),
              h('button', { style: btn, onClick: loadFiles, title: '重新扫描工作区的 NC 文件' }, '扫描'),
              h('button', { style: btn, onClick: () => { load(); loadFiles(); }, title: '刷新' }, '刷新')),
            diagCwd ? h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-state-business-primary, #2563eb)', marginBottom: 4, wordBreak: 'break-all' }, title: '当前会话工作区（sessionId: ' + (sessionId || '无') + '）' }, '当前工作区：' + diagCwd) : null,
            changedNc.length > 0
              ? h('div', {
                  style: {
                    margin: '4px 0 6px', padding: '8px 10px', borderRadius: 8,
                    background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-brand-primary, #2563eb)',
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
                    h('span', { style: { flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } },
                      '✨ AI 刚修改了 ' + changedNc.length + ' 个 NC 文件，点击直接打开：'),
                    h('button', {
                      onClick: () => { setChangedNc([]); if (sessionId) fetch('/dsh-cam/changed?session=' + encodeURIComponent(sessionId) + '&seq=1').catch(() => {}); },
                      style: { ...btn, fontSize: 11, padding: '2px 8px' },
                    }, '忽略')),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                    changedNc.map((f) => h('button', {
                      key: f.path,
                      onClick: () => { setEditingFile(f.path); setOpen(true); },
                      title: f.path,
                      style: {
                        display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left', cursor: 'pointer',
                        padding: '4px 8px', fontSize: 12, borderRadius: 5,
                        border: 'none', background: 'transparent',
                        color: 'var(--dsw-alias-brand-primary, #2563eb)',
                      },
                    },
                      h('span', { style: { fontSize: 12 } }, '📄'),
                      h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.display || f.path),
                      h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, (f.added > 0 ? '+' + f.added : '') + (f.deleted > 0 ? (f.added > 0 ? ' −' : '−') + f.deleted : '')))),
                ))
              : null,
            ncCount === 0
              ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '工作区未发现 .nc/.cnc/.gcode 文件，点「选择路径」或「扫描」')
              : h(React.Fragment, null,
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: listExpanded ? 360 : 110, overflow: 'auto' } }, fileItems),
                  h('button', {
                    onClick: () => setListExpanded((v) => !v), title: listExpanded ? '收起列表' : '展开列表',
                    style: {
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, width: '100%',
                      padding: '3px 0', fontSize: 11, cursor: 'pointer',
                      border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #6b7280)',
                    },
                  }, listExpanded ? '收起 ▲' : '展开 ▼'))),
          h('div', { style: { padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)' } },
            h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #6b7280)', marginBottom: 6 } },
              'STEP 模型' + (files.steps.length > 0 ? '（点击选择，自动填入并生成）' : '')),
            files.steps.length === 0
              ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '工作区未发现 .step/.stp 文件')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 90, overflow: 'auto' } }, stepItems),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              h('input', { style: input, value: modelFile, placeholder: '或手动输入 STEP 路径', onChange: (e) => setModelFile(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') generate(); } }),
              h('button', { style: btnPrimary, onClick: generate, disabled: busy }, busy ? '生成中…' : '生成刀路'))),
          h('div', { style: { flex: 1, overflow: 'hidden', padding: 10, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            err ? h('div', { style: { padding: 8, color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12, marginBottom: 8 } }, '错误：' + err) : null,
            h(Viewer3D, { data })),
        )));
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        appCtx = ctx;
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-cam-toolpath', order: 90, label: 'QizhouCNC_CAM',
        }, ToolpathPanel)), 'dsh-cam: floating toolpath panel');

        // feature 4: 接管会话中 .nc/.cnc/.gcode 文件名的点击，跳转到本插件编辑界面
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: NC_TAB_TYPE_ID,
          kind: NC_TAB_KIND,
          patterns: [
            'dsh-resource://file/**/*.nc',
            'dsh-resource://file/**/*.cnc',
            'dsh-resource://file/**/*.gcode',
            '**/*.nc', '**/*.cnc', '**/*.gcode',
          ],
          priority: 'extension',
          canOpen: (address) => {
            const parsed = parseFileAddress(address);
            return !!parsed && /\.(nc|cnc|gcode)$/i.test(parsed.path);
          },
          title: (address) => {
            const parsed = parseFileAddress(address);
            return parsed ? basenameOf(parsed.path) : 'NC 程序';
          },
        }), 'dsh-cam: sidebar nc-toolpath tab type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: NC_TAB_TYPE_ID,
        }, NcToolpathTab)), 'dsh-cam: sidebar nc-toolpath tab body');
      },
    };
  },
});
