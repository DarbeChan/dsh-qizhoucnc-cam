window.__ModuleLoader__.load({
  id: 'dsh-qizhoucnc-cam',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // 「引用到对话框」所需：apply(ctx) 存下 root ctx，点击时惰性解析 conversation 服务
    // （ConversationController.input = InputHub）。立即加载时序下 apply 阶段该服务可能尚未就绪。
    let appCtx = null;

    // feature 4 跳板事件：右栏 tab 挂载后，把「打开 NC」转发给浮动面板（QizhouCNC_CAM 编辑界面）
    const OPEN_NC_EVENT = 'dsh-cam:open-nc';

    // ============ dsh-resource://file 地址解码（与 DSH docpreview 同源语义） ============
    // 会话中蓝色文件名点击 → openFile → sidebarRight.openResource(dsh-resource://file/session/<id>/<path>)
    // 本插件注册更高优先级(extension)的 tab 类型接管 .nc/.cnc/.gcode，解码地址后在本插件编辑器打开。
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    function basenameOf(path) { return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path; }
    function formatBytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      return (v / 1024 / 1024).toFixed(2) + ' MB';
    }
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

    // 未绕俯仰/偏航的完整 3D 旋转（用于「视线深度」计算：越靠近视点的点深度越小）。
    // 与 project3d 的前两步一致，只是保留 z（viewer 的视线沿 z 轴负向）。
    function rotateView(p, yaw, pitch) {
      const [x, y, z] = p;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const x1 = x * cy - y * sy;
      const y1 = x * sy + y * cy;
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const y2 = y1 * cp + z * sp;
      const z2 = -y1 * sp + z * cp;
      return [x1, y2, z2];
    }

    // 点在三角形内的重心坐标（屏幕 2D）。命中返回 {u,v,w}（对应 a,b,c 三顶点），否则 null。
    function barycentric(px, py, ax, ay, bx, by, cx2, cy2) {
      const v0x = cx2 - ax, v0y = cy2 - ay;
      const v1x = bx - ax, v1y = by - ay;
      const v2x = px - ax, v2y = py - ay;
      const d00 = v0x * v0x + v0y * v0y;
      const d01 = v0x * v1x + v0y * v1y;
      const d11 = v1x * v1x + v1y * v1y;
      const d20 = v2x * v0x + v2y * v0y;
      const d21 = v2x * v1x + v2y * v1y;
      const denom = d00 * d11 - d01 * d01;
      if (Math.abs(denom) < 1e-12) return null;
      const w = (d11 * d20 - d01 * d21) / denom;
      const v = (d00 * d21 - d01 * d20) / denom;
      const u = 1 - v - w;
      if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return { u, v, w };
      return null;
    }

    // 点到线段的（平方）屏幕距离。
    function pointSegDistSq(px, py, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) { const ex = px - ax, ey = py - ay; return ex * ex + ey * ey; }
      let t = ((px - ax) * dx + (py - ay) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const ex = px - cx, ey = py - cy;
      return ex * ex + ey * ey;
    }

    // 夹具/毛坯位姿：对点先绕 Z/Y/X 旋转（度），再平移（mm）。
    function applyAssetTransform(p, t) {
      if (!t) return p;
      const tr = t.translate || [0, 0, 0];
      const rt = t.rotate || [0, 0, 0];
      let [x, y, z] = p;
      // 绕 Z
      const rz = (rt[2] || 0) * Math.PI / 180;
      if (rz) { const c = Math.cos(rz), s = Math.sin(rz); const nx = x * c - y * s; const ny = x * s + y * c; x = nx; y = ny; }
      // 绕 Y
      const ry = (rt[1] || 0) * Math.PI / 180;
      if (ry) { const c = Math.cos(ry), s = Math.sin(ry); const nx = x * c + z * s; const nz = -x * s + z * c; x = nx; z = nz; }
      // 绕 X
      const rx = (rt[0] || 0) * Math.PI / 180;
      if (rx) { const c = Math.cos(rx), s = Math.sin(rx); const ny = y * c - z * s; const nz = y * s + z * c; y = ny; z = nz; }
      return [x + (tr[0] || 0), y + (tr[1] || 0), z + (tr[2] || 0)];
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
      const [maximized, setMaximized] = React.useState(false);
      const W = 600, H = 460, cx = W / 2, cy = H / 2;

      // ESC 退出放大
      React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const onKey = (e) => { if (e.key === 'Escape') setMaximized(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

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

      // 放大按钮（刀路视窗放大/还原，与模型视窗同款交互）
      const maxBtn = h('button', {
        onClick: () => setMaximized((v) => !v),
        title: maximized ? '还原刀路视窗大小' : '放大刀路视窗（全屏操作）',
        style: {
          marginLeft: 'auto', padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5,
          border: '1px solid ' + (maximized ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)'),
          background: maximized ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 12%, transparent)' : 'transparent',
          color: maximized ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111)',
          fontWeight: maximized ? 600 : 400,
        },
      }, maximized ? '还原' : '⛶ 放大');

      const viewerInner = [
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', marginRight: 2 } }, '视图'),
          VIEWS.map((v) => viewBtn(v, activeView === v)),
          h('button', { style: { padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)' }, onClick: () => setView(fitView(0.7, 0.55)), title: '重置视图并适配' }, '重置'),
          maxBtn),
        h('svg', {
          viewBox: '0 0 ' + W + ' ' + H, width: '100%',
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
      ];

      if (maximized) {
        return h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 3050, background: 'var(--dsw-alias-bg-base, #fff)',
            padding: 16, display: 'flex', flexDirection: 'column', gap: 6,
            boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
          },
        }, ...viewerInner);
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 } },
        ...viewerInner,
      );
    }

    // ============ 3D 模型视窗（三角面渲染 + 选面/选边拾取 + 标注加工位置） ============
    // scene 来自 /dsh-cam/model：{ bounds:{min,max}, faces:[{id,vertices,triangles,center,area}], edges:[{id,points}] }
    // selected: { kind:'face'|'edge', id } | null；点击面/边时回传 onSelect。
    // pivot: [x,y,z] 旋转轴心；默认取模型包围盒中心。旋转/缩放都围绕该点。
    function ModelViewer3D({ scene, selected, selectedSet, onSelect, onAnnotate, onSelectMulti, onConfirmMulti, pivot, features, locate, overlays, transform, maximized, onToggleMaximize }) {
      const [view, setView] = React.useState(null);
      const drag = React.useRef(null);
      // 单击/双击判定：记录上次点击的目标与时间（同目标 350ms 内再次点击 = 双击标注）
      const clickState = React.useRef({ time: 0, kind: null, id: null });
      const clickTimer = React.useRef(null);
      const svgRef = React.useRef(null);
      // 悬停命中：与点击共用同一套几何深度拾取（hitTest），
      // 消除「hover 高亮的面 ≠ 点击选中的面」导致的选面跳变。
      const [hoverHit, setHoverHit] = React.useState(null);
      const hoverThrottle = React.useRef(0);
      const W = 600, H = 460, cx = W / 2, cy = H / 2;
      // 显示模式（对齐 DSH-CAD）：faces-edges=面+边、faces=仅面、wireframe=全是线
      const RENDER_MODES = [
        { id: 'faces-edges', label: '面+边' },
        { id: 'faces', label: '面' },
        { id: 'wireframe', label: '线' },
      ];
      const [renderMode, setRenderMode] = React.useState('faces-edges');
      // 多选集合的命中映射：kind:id -> true
      const selSetMap = React.useMemo(() => {
        const m = {};
        for (const s of (selectedSet || [])) m[s.kind + ':' + s.id] = true;
        return m;
      }, [selectedSet]);
      const pv = pivot || [0, 0, 0];
      // 主体模型的位移/旋转（与夹具/毛坯同款 transform）：{ translate:[x,y,z], rotate:[rx,ry,rz] }
      const xf = transform || null;
      const tpv = xf ? applyAssetTransform(pv, xf) : pv;
      // 已标注特征：kind+refId → feature 记录（用于橙色高亮）。
      // 批量标注（refIds）的特征，其每一个成员面/边都要映射到该记录，这样
      // 「一起标注」的 N 个面/边会被一起高亮。
      const featMap = React.useMemo(() => {
        const m = {};
        for (const f of features || []) {
          m[f.kind + ':' + f.refId] = f;
          if (Array.isArray(f.refIds)) {
            for (const id of f.refIds) m[f.kind + ':' + id] = f;
          }
        }
        return m;
      }, [features]);

      // 点击左侧标注列表某条 → 定位到模型对应面/边并高亮。
      // locate.ids 存在时（批量标注）高亮全部成员。
      const locateIdSet = React.useMemo(() => {
        const s = {};
        if (locate) {
          s[locate.kind + ':' + locate.id] = true;
          if (Array.isArray(locate.ids)) for (const id of locate.ids) s[locate.kind + ':' + id] = true;
        }
        return s;
      }, [locate]);

      const toScreen = React.useCallback((p) => {
        const q = xf ? applyAssetTransform(p, xf) : p;
        const [sx, sy] = project3d([q[0] - tpv[0], q[1] - tpv[1], q[2] - tpv[2]], view.yaw, view.pitch);
        return [cx + sx * view.zoom + view.panX, cy + sy * view.zoom + view.panY];
      }, [view, tpv[0], tpv[1], tpv[2], xf]);

      // 不应用主体 transform（xf）的投影：用于坐标轴/网格，让「加工坐标系」保持固定方向，
      // 只随视窗 yaw/pitch 旋转，不随工件的位移/旋转（transform）而转动。
      const toScreenNoXf = React.useCallback((p) => {
        const [sx, sy] = project3d([p[0] - tpv[0], p[1] - tpv[1], p[2] - tpv[2]], view.yaw, view.pitch);
        return [cx + sx * view.zoom + view.panX, cy + sy * view.zoom + view.panY];
      }, [view, tpv[0], tpv[1], tpv[2]]);

      // 视空间：返回 [screenX, screenY, depth]。depth 沿视线（越大 = 越靠前/越靠近视点）。
      // 用于「最前面」几何拾取：命中多个面时取 depth 最大的那个。
      const toView = React.useCallback((p) => {
        const q = xf ? applyAssetTransform(p, xf) : p;
        const [sx, sy, sz] = rotateView([q[0] - tpv[0], q[1] - tpv[1], q[2] - tpv[2]], view.yaw, view.pitch);
        return [cx + sx * view.zoom + view.panX, cy + sy * view.zoom + view.panY, sz];
      }, [view, tpv[0], tpv[1], tpv[2], xf]);

      // fit the whole model into the viewport for a given yaw/pitch (relative to pivot)
      const fitView = React.useCallback((yaw, pitch) => {
        const bb = scene && scene.bounds;
        if (!bb) return { yaw, pitch, panX: 0, panY: 0, zoom: 1 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        // 用所有面的顶点投影范围计算 zoom（比仅包围盒 8 角点更贴合真实形状，
        // 对细长件/复杂件适配更准，避免模型被缩得太小或溢出）。
        const consider = (p) => {
          const q = xf ? applyAssetTransform(p, xf) : p;
          const [sx, sy] = project3d([q[0] - tpv[0], q[1] - tpv[1], q[2] - tpv[2]], yaw, pitch);
          if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
        };
        const corners = [
          [bb.min[0], bb.min[1], bb.min[2]], [bb.max[0], bb.min[1], bb.min[2]],
          [bb.min[0], bb.max[1], bb.min[2]], [bb.max[0], bb.max[1], bb.min[2]],
          [bb.min[0], bb.min[1], bb.max[2]], [bb.max[0], bb.min[1], bb.max[2]],
          [bb.min[0], bb.max[1], bb.max[2]], [bb.max[0], bb.max[1], bb.max[2]],
        ];
        corners.forEach(consider);
        // 补充每个面的中心点，进一步收紧适配范围
        if (scene && Array.isArray(scene.faces)) {
          for (const f of scene.faces) {
            if (f.center) consider(f.center);
          }
        }
        const w = maxX - minX, h = maxY - minY;
        const zoom = Math.min((W - 40) / Math.max(1e-6, w), (H - 40) / Math.max(1e-6, h));
        return { yaw, pitch, panX: 0, panY: 0, zoom: Math.max(0.05, Math.min(20, zoom)) };
      }, [scene, tpv[0], tpv[1], tpv[2], xf]);

      // (re)fit when the scene changes
      React.useEffect(() => { setView(fitView(0.7, 0.55)); }, [scene, fitView]);

      // 命中测试（useCallback）：几何拾取「最前面的」面/边，供 hover 与点击共用。
      // 必须定义在早退 return 之前，保证 hook 顺序固定（否则 scene 从 null → 有值时
      // hook 数量变化会触发 React 崩溃）。
      const hitTest = React.useCallback((clientX, clientY) => {
        let px = clientX, py = clientY, unit = 1;
        const svg = svgRef.current;
        if (svg && typeof svg.getBoundingClientRect === 'function') {
          const r = svg.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            px = (clientX - r.left) * (W / r.width);
            py = (clientY - r.top) * (H / r.height);
            unit = W / r.width;
          }
        }
        let best = null;
        let bestDistSq = Infinity;
        if (scene && Array.isArray(scene.faces)) {
          for (const f of scene.faces) {
            const v = f.vertices;
            const tris = f.triangles;
            if (!v || !tris) continue;
            for (const tri of tris) {
              const a = v[tri[0]], b = v[tri[1]], c = v[tri[2]];
              if (!a || !b || !c) continue;
              const [ax, ay] = toScreen(a), [bx, by] = toScreen(b), [cx2, cy2] = toScreen(c);
              const bc = barycentric(px, py, ax, ay, bx, by, cx2, cy2);
              if (!bc) continue;
              const depth = toView(a)[2] * bc.u + toView(b)[2] * bc.v + toView(c)[2] * bc.w;
              if (!best || best.kind !== 'face' || depth > best.depth) {
                best = { kind: 'face', id: f.id, depth };
              }
            }
          }
        }
        if (best) return { kind: best.kind, id: best.id };
        const tolPx = 8 * unit;
        let bestEdge = null;
        if (scene && Array.isArray(scene.edges)) {
          for (const e of scene.edges) {
            const pts = e.points;
            if (!pts || pts.length < 2) continue;
            for (let i = 0; i < pts.length - 1; i++) {
              const [ax, ay] = toScreen(pts[i]);
              const [bx, by] = toScreen(pts[i + 1]);
              const d2 = pointSegDistSq(px, py, ax, ay, bx, by);
              if (d2 < bestDistSq) { bestDistSq = d2; bestEdge = e.id; }
            }
          }
        }
        if (bestEdge !== null && bestDistSq <= tolPx * tolPx) {
          return { kind: 'edge', id: bestEdge };
        }
        return null;
      }, [scene, toScreen, toView, W, H]);

      // 键盘（useEffect）：ENTER = 批量标注；ESC = 清空多选。同样须在早退 return 之前。
      React.useEffect(() => {
        const onKey = (e) => {
          const tag = (e.target && e.target.tagName) || '';
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (e.key === 'Enter') {
            const sel = (selectedSet || []);
            if (sel.length > 1 && typeof onConfirmMulti === 'function') {
              e.preventDefault();
              onConfirmMulti(sel);
            }
          } else if (e.key === 'Escape') {
            if (!maximized && (selectedSet || []).length > 0 && typeof onConfirmMulti === 'function') {
              e.preventDefault();
              onConfirmMulti(null);
            }
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [selectedSet, onConfirmMulti, maximized]);

      if (!view || !scene) return h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', fontSize: 13 } }, '加载模型…');

      const bb = scene.bounds;
      const baseZ = pv[2];
      const half = bb ? Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2 : 50;
      const R = Math.max(half * 1.4, 10);

      const line = (pts, color, width, dash) => {
        let d = '';
        pts.forEach((p, j) => { const [sx, sy] = toScreen(p); d += (j === 0 ? 'M' : 'L') + sx.toFixed(1) + ' ' + sy.toFixed(1); });
        return h('path', { d, fill: 'none', stroke: color, strokeWidth: width, strokeDasharray: dash, strokeLinejoin: 'round', strokeLinecap: 'round' });
      };
      // 不应用主体 transform 的线（坐标轴/网格用，保持加工坐标系固定方向）
      const lineNoXf = (pts, color, width, dash) => {
        let d = '';
        pts.forEach((p, j) => { const [sx, sy] = toScreenNoXf(p); d += (j === 0 ? 'M' : 'L') + sx.toFixed(1) + ' ' + sy.toFixed(1); });
        return h('path', { d, fill: 'none', stroke: color, strokeWidth: width, strokeDasharray: dash, strokeLinejoin: 'round', strokeLinecap: 'round' });
      };

      // grid + axes (centered on the rotation pivot)
      const step = Math.max(1, Math.round(R / 5));
      const gridLines = [];
      for (let v = -R; v <= R + 1e-9; v += step) {
        gridLines.push([[pv[0] - R, pv[1] + v, baseZ], [pv[0] + R, pv[1] + v, baseZ]]);
        gridLines.push([[pv[0] + v, pv[1] - R, baseZ], [pv[0] + v, pv[1] + R, baseZ]]);
      }
      const axLen = R * 1.1;
      const axes = [
        { pts: [pv, [pv[0] + axLen, pv[1], pv[2]]], color: 'var(--dsw-alias-state-error-primary, #ef4444)' },
        { pts: [pv, [pv[0], pv[1] + axLen, pv[2]]], color: 'var(--dsw-alias-state-success-primary, #22c55e)' },
        { pts: [pv, [pv[0], pv[1], pv[2] + axLen]], color: 'var(--dsw-alias-state-business-primary, #3b82f6)' },
      ];

      const FACE_FILL = '#c7d2e0';
      const FACE_SELECTED = 'rgba(255,154,61,0.55)';
      const FACE_HOVER = 'rgba(77,107,254,0.35)';
      const EDGE_COLOR = '#64748b';
      const EDGE_SELECTED = '#ff9a3d';
      const FEAT_FILL = 'rgba(255,154,61,0.72)'; // 已标注特征：橙色高亮
      const LOCATE_FILL = 'rgba(34,197,94,0.85)'; // 点击标签定位：亮绿高亮
      const LOCATE_STROKE = '#16a34a';

      // 光照着色：按面法向做朗伯明暗（Lambert），让每个面有明暗层次，立体感强、
      // 与浅色/深色背景都能区分开，避免纯色与背景融合。
      const LIGHT = (() => { const l = [0.42, 0.36, 0.83]; const m = Math.hypot(l[0], l[1], l[2]); return [l[0] / m, l[1] / m, l[2] / m]; })();
      const rotateDir = (p, yaw, pitch) => {
        const [x, y, z] = p;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        return [x1, y1 * cp + z * sp, -y1 * sp + z * cp];
      };
      const faceNormal = (f) => {
        for (const tri of f.triangles) {
          const a = f.vertices[tri[0]], b = f.vertices[tri[1]], c = f.vertices[tri[2]];
          const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
          const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
          const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          const len = Math.hypot(nx, ny, nz);
          if (len > 1e-9) return [nx / len, ny / len, nz / len];
        }
        return [0, 0, 1];
      };
      const shadeOf = (n) => {
        const rn = rotateDir(n, view.yaw, view.pitch);
        const nd = rn[0] * LIGHT[0] + rn[1] * LIGHT[1] + rn[2] * LIGHT[2];
        return 0.34 + 0.66 * Math.max(0, nd);
      };

      // faces → ONE <path> per face (merge all its triangles into a single path).
      // 每个三角形若独立成 <polygon>，复杂 STEP 会有上万 DOM 节点导致崩溃；
      // 合并成单 path 后，DOM 节点数 = 面数，性能与内存都安全。
      const faceEls = [];
      for (const f of scene.faces) {
        const isSel = selected && selected.kind === 'face' && selected.id === f.id;
        const isMultiSel = !!selSetMap['face:' + f.id];
        const isFeat = featMap['face:' + f.id];
        const isLoc = !!locateIdSet['face:' + f.id];
        // hover 高亮改用几何拾取结果（hoverHit），与点击选中的面完全一致，
        // 消除「hover 看到的面 ≠ 点击锁定的面」的跳变。
        const isHover = !!hoverHit && hoverHit.kind === 'face' && hoverHit.id === f.id;
        const shade = shadeOf(faceNormal(f));
        const r = Math.round(96 * shade), g = Math.round(116 * shade), b = Math.round(140 * shade);
        const baseFill = 'rgb(' + r + ',' + g + ',' + b + ')';
        // hover 灰亮高亮：用明显的蓝色半透明覆盖（而非微弱提亮），确保可见。
        const fillColor = isLoc ? LOCATE_FILL : (isFeat ? FEAT_FILL : ((isSel || isMultiSel) ? FACE_SELECTED : (isHover ? FACE_HOVER : baseFill)));
        // 线框模式下不填面（只画边线）；其它模式填面。
        const showFaceFill = renderMode !== 'wireframe';
        // 面不再给每个三角形描边（消除网格外观），只在选中/标注/定位时描边。
        const strokeColor = isLoc ? LOCATE_STROKE : (isFeat ? '#f97316' : ((isSel || isMultiSel) ? '#f97316' : (isHover ? '#2563eb' : 'none')));
        const strokeW = isLoc ? 2.4 : (isFeat ? 0.8 : ((isSel || isMultiSel) ? 0.8 : (isHover ? 1.2 : 0)));
        let d = '';
        for (const tri of f.triangles) {
          const a = f.vertices[tri[0]], b = f.vertices[tri[1]], c = f.vertices[tri[2]];
          const [ax, ay] = toScreen(a), [bx, by] = toScreen(b), [cx2, cy2] = toScreen(c);
          d += 'M' + ax.toFixed(1) + ' ' + ay.toFixed(1)
             + 'L' + bx.toFixed(1) + ' ' + by.toFixed(1)
             + 'L' + cx2.toFixed(1) + ' ' + cy2.toFixed(1) + 'Z';
        }
        faceEls.push(h('path', {
          key: 'f' + f.id,
          d,
          fill: showFaceFill ? fillColor : 'none',
          stroke: strokeColor,
          strokeWidth: strokeW, strokeLinejoin: 'round',
          style: { cursor: 'pointer' },
          'data-hit': 'face', 'data-id': f.id,
        }));
      }
      // edges as individual <polyline> for picking
      const edgeEls = [];
      for (const e of scene.edges) {
        const isSel = selected && selected.kind === 'edge' && selected.id === e.id;
        const isMultiSel = !!selSetMap['edge:' + e.id];
        const isFeat = featMap['edge:' + e.id];
        const isLoc = !!locateIdSet['edge:' + e.id];
        const isHover = !!hoverHit && hoverHit.kind === 'edge' && hoverHit.id === e.id;
        // 显示模式：faces=仅面不显示边线；wireframe=全是线（边线加粗）；faces-edges=面+边。
        const showEdges = renderMode !== 'faces';
        if (!showEdges) continue;
        const edgeBaseColor = renderMode === 'wireframe' ? 'var(--dsw-alias-label-primary, #111)' : EDGE_COLOR;
        const edgeBaseWidth = renderMode === 'wireframe' ? 1.8 : 1.2;
        let pts = '';
        e.points.forEach((p, j) => { const [sx, sy] = toScreen(p); pts += (j === 0 ? '' : ' ') + sx.toFixed(1) + ',' + sy.toFixed(1); });
        edgeEls.push(h('polyline', {
          key: 'e' + e.id,
          points: pts,
          fill: 'none',
          stroke: isLoc ? LOCATE_STROKE : (isFeat ? '#f97316' : ((isSel || isMultiSel) ? EDGE_SELECTED : (isHover ? '#2563eb' : edgeBaseColor))),
          strokeWidth: isLoc ? 4.4 : (isFeat ? 3.2 : ((isSel || isMultiSel) ? 3 : (isHover ? 2.6 : edgeBaseWidth))),
          strokeLinejoin: 'round', strokeLinecap: 'round',
          style: { cursor: 'pointer' },
          'data-hit': 'edge', 'data-id': e.id,
        }));
      }

      // ---- overlays (夹具/毛坯): render extra models with role-tinted colors, NOT pickable ----
      const overlayEls = [];
      const ROLE_COLORS = {
        fixture: { face: 'rgba(99,102,241,0.30)', stroke: 'rgba(79,70,229,0.85)', edge: 'rgba(129,140,248,0.95)' },
        blank: { face: 'rgba(16,185,129,0.22)', stroke: 'rgba(5,150,105,0.85)', edge: 'rgba(52,211,153,0.95)' },
      };
      for (const ov of (overlays || [])) {
        const oscene = ov && ov.scene;
        if (!oscene || !Array.isArray(oscene.faces)) continue;
        const rc = ROLE_COLORS[ov.asset && ov.asset.role] || ROLE_COLORS.blank;
        const xf = ov.asset && ov.asset.transform ? ov.asset.transform : null;
        // faces: one path per face (semi-transparent role tint), with transform applied
        for (const f of oscene.faces) {
          let d = '';
          for (const tri of f.triangles) {
            const a = applyAssetTransform(f.vertices[tri[0]], xf), b = applyAssetTransform(f.vertices[tri[1]], xf), c = applyAssetTransform(f.vertices[tri[2]], xf);
            const [ax, ay] = toScreen(a), [bx, by] = toScreen(b), [cx2, cy2] = toScreen(c);
            d += 'M' + ax.toFixed(1) + ' ' + ay.toFixed(1) + 'L' + bx.toFixed(1) + ' ' + by.toFixed(1) + 'L' + cx2.toFixed(1) + ' ' + cy2.toFixed(1) + 'Z';
          }
          overlayEls.push(h('path', {
            key: 'ov-' + ov.asset.id + '-f' + f.id,
            d, fill: rc.face, stroke: rc.stroke, strokeWidth: 0.4, strokeLinejoin: 'round',
            pointerEvents: 'none',
          }));
        }
        // edges
        for (const e of oscene.edges) {
          let pts = '';
          e.points.forEach((p, j) => { const q = applyAssetTransform(p, xf); const [sx, sy] = toScreen(q); pts += (j === 0 ? '' : ' ') + sx.toFixed(1) + ',' + sy.toFixed(1); });
          overlayEls.push(h('polyline', {
            key: 'ov-' + ov.asset.id + '-e' + e.id,
            points: pts, fill: 'none', stroke: rc.edge, strokeWidth: 1.2,
            strokeLinejoin: 'round', strokeLinecap: 'round', pointerEvents: 'none',
          }));
        }
      }

      // 命中测试已上移到早退 return 之前（见上方 hitTest useCallback），
      // 此处只保留依赖 hitTest 的普通函数（非 hook）。

      // hover 命中（节流）：更新 hoverHit 以驱动悬停高亮；与点击共用 hitTest。
      const onPointerHover = (e) => {
        if (drag.current) { setHoverHit(null); return; }
        const now = Date.now();
        if (now - hoverThrottle.current < 24) return; // ~40fps 节流，避免大模型下卡顿
        hoverThrottle.current = now;
        const hit = hitTest(e.clientX, e.clientY);
        setHoverHit(hit);
      };
      const onPointerLeave = () => { setHoverHit(null); };
      // 单击/双击：同一面/边 350ms 内两次点击 = 双击（标注），否则单击（选中）。
      // shiftKey=true 时走多选（Shift+点击），不做双击判定。
      const fireClick = (hit, shiftKey) => {
        if (!hit) return;
        const now = Date.now();
        const prev = clickState.current;
        // Shift 多选：直接切换该面/边在多选集合中的状态（不触发双击标注）
        if (shiftKey && typeof onSelectMulti === 'function') {
          clearTimeout(clickTimer.current);
          clickState.current = { time: 0, kind: null, id: null };
          onSelectMulti({ kind: hit.kind, id: hit.id });
          return;
        }
        if (prev && prev.kind === hit.kind && prev.id === hit.id && (now - prev.time) < 350) {
          clearTimeout(clickTimer.current);
          clickState.current = { time: 0, kind: null, id: null };
          if (hit.kind === 'face') {
            const f = scene.faces.find((x) => x.id === hit.id);
            if (f) onAnnotate({ kind: 'face', id: f.id, center: f.center, area: f.area });
          } else {
            const ed = scene.edges.find((x) => x.id === hit.id);
            if (ed) onAnnotate({ kind: 'edge', id: ed.id, points: ed.points });
          }
          return;
        }
        clickState.current = { time: now, kind: hit.kind, id: hit.id };
        clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => {
          clickState.current = { time: 0, kind: null, id: null };
          if (hit.kind === 'face') {
            const f = scene.faces.find((x) => x.id === hit.id);
            if (f) onSelect({ kind: 'face', id: f.id, center: f.center, area: f.area });
          } else {
            const ed = scene.edges.find((x) => x.id === hit.id);
            if (ed) onSelect({ kind: 'edge', id: ed.id, points: ed.points });
          }
        }, 350);
      };

      // 用与刀路 Viewer3D 相同的 setPointerCapture 拖拽模式：可靠旋转/平移（Electron 下最稳）。
      const onPointerDown = (e) => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          x: e.clientX, y: e.clientY,
          yaw: view.yaw, pitch: view.pitch, panX: view.panX, panY: view.panY,
          mode: (e.button === 2 || e.shiftKey) ? 'pan' : 'rotate',
          moved: false,
        };
      };
      const onPointerMove = (e) => {
        const d = drag.current;
        if (!d) { onPointerHover(e); return; }
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (!d.moved) return;
        if (d.mode === 'pan') setView((v) => ({ ...v, panX: d.panX + dx, panY: d.panY + dy }));
        else setView((v) => ({ ...v, yaw: d.yaw + dx * 0.01, pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, d.pitch + dy * 0.01)) }));
      };
      const onPointerUp = (e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          // 未拖拽 = 一次点击：命中面/边则触发单击/双击判定（Shift = 多选）
          fireClick(hitTest(e.clientX, e.clientY), !!e.shiftKey);
        }
      };
      const onWheel = (e) => { e.preventDefault(); setView((v) => ({ ...v, zoom: Math.max(0.05, Math.min(20, v.zoom * (e.deltaY < 0 ? 1.12 : 0.9))) })); };

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

      const selCount = (selectedSet && selectedSet.length) || 0;
      const selText = selected
        ? (selected.kind === 'face' ? '已选面 #' + selected.id + (selected.area ? ' · ' + Math.round(selected.area) + ' mm²' : '') : '已选边 #' + selected.id)
          + (selCount > 1 ? ' 等 ' + selCount + ' 个（Shift 多选，Enter 批量标注）' : '（双击标注）')
        : '单击选中面或边线 · 双击标注 · Shift+点击多选 · Enter 批量标注';

      // 最大化按钮 + 恢复按钮（模型视窗放大/还原）
      const maxBtn = h('button', {
        onClick: () => (typeof onToggleMaximize === 'function' ? onToggleMaximize() : null),
        title: maximized ? '还原模型视窗大小' : '放大模型视窗（全屏操作）',
        style: {
          marginLeft: 'auto', padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5,
          border: '1px solid ' + (maximized ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)'),
          background: maximized ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 12%, transparent)' : 'transparent',
          color: maximized ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111)',
          fontWeight: maximized ? 600 : 400,
        },
      }, maximized ? '还原' : '⛶ 放大');

      // SVG 视窗（普通内嵌或全屏遮罩共用同一份渲染逻辑）
      const svgBlock = (style) => h('svg', {
        ref: svgRef,
        viewBox: '0 0 ' + W + ' ' + H, width: '100%',
        style: { background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', touchAction: 'none', cursor: 'grab', flex: 1, minHeight: 0, ...style },
        onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
        onPointerLeave,
        onWheel, onContextMenu: (e) => e.preventDefault(),
      },
        gridLines.map((g, i) => lineNoXf(g, 'var(--dsw-alias-border-l1, #e5e7eb)', 0.5)),
        axes.map((a, i) => lineNoXf(a.pts, a.color, 1.2)),
        h('g', null, faceEls),
        h('g', null, edgeEls),
        h('g', null, overlayEls));

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 } },
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', marginRight: 2 } }, '视图'),
          VIEWS.map((v) => viewBtn(v, activeView === v)),
          h('button', { style: { padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'transparent', color: 'var(--dsw-alias-label-primary, #111)' }, onClick: () => setView(fitView(0.7, 0.55)), title: '重置视图并适配' }, '重置'),
          // 显示模式切换（对齐 DSH-CAD：面+边 / 面 / 线）
          h('button', {
            onClick: () => {
              const cur = RENDER_MODES.findIndex((m) => m.id === renderMode);
              setRenderMode(RENDER_MODES[(cur + 1) % RENDER_MODES.length].id);
            },
            title: '切换显示模式（面+边 / 仅面 / 全是线）',
            style: {
              padding: '1px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 5,
              border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #111)',
            },
          }, RENDER_MODES.find((m) => m.id === renderMode).label),
          maxBtn),
        svgBlock({}),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } },
          h('span', { style: { flex: 1, color: selected ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-tertiary, #9ca3af)', fontWeight: selected ? 600 : 400 } }, selText),
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
            '拖拽=旋转 · Shift/右键=平移 · 滚轮=缩放 · 面 ' + scene.faces.length + ' · 边 ' + scene.edges.length)),
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
    const edFindInput = {
      flex: 1, minWidth: 0, padding: '4px 10px', fontSize: 12, lineHeight: '20px',
      fontFamily: 'var(--dsw-alias-font-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      border: '1px solid var(--dsw-alias-border-l1, #d1d5db)', outline: 'none',
      background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      borderRadius: 6, height: 28, boxSizing: 'border-box',
      caretColor: 'var(--dsw-alias-label-primary, #1a1a1a)',
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
      // 文本存于 ref（不受控 textarea）：大 NC 文件下受控 textarea 每次交互都会让 React
      // 重新序列化整段字符串，Ctrl+A 全选会导致卡死/无响应甚至拖垮宿主。改用 defaultValue +
      // 直接读 DOM，只在「行数/查找」等轻量派生值变化时才 setState。
      const [loaded, setLoaded] = React.useState(false);
      const [err, setErr] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [savedAt, setSavedAt] = React.useState(null);
      const [menu, setMenu] = React.useState(null); // { x, y, sel, startLine, endLine }
      const [lineCount, setLineCount] = React.useState(0);
      const [initialText, setInitialText] = React.useState('');
      const taRef = React.useRef(null);
      const textRef = React.useRef(''); // 当前文本的镜像，避免频繁 split 全串
      // 查找：Ctrl+F / Cmd+F
      const [findOpen, setFindOpen] = React.useState(false);
      const [findQuery, setFindQuery] = React.useState('');
      const [findCount, setFindCount] = React.useState(0);
      const findRef = React.useRef(null);

      const post = React.useCallback((path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()), []);

      // 读取 textarea 当前文本（不触发 React 渲染）
      const currentText = React.useCallback(() => {
        if (taRef.current) return taRef.current.value;
        return textRef.current;
      }, []);

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
      const doQuote = (sel, startLine, endLine, selStart, selEnd) => {
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
          // 引用后把焦点与选区恢复到编辑器，避免选中高亮消失
          if (typeof selStart === 'number' && typeof selEnd === 'number') {
            const ta = taRef.current;
            if (ta) {
              try {
                ta.focus();
                ta.setSelectionRange(selStart, selEnd);
              } catch (e2) { /* ignore */ }
            }
          }
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
        const sel = ta.value.slice(start, end);
        if (!sel.trim()) { setErr('选中的内容为空'); setMenu(null); return; }
        setMenu({
          x: e.clientX, y: e.clientY, sel,
          selStart: start, selEnd: end,
          startLine: ta.value.slice(0, start).split('\n').length,
          endLine: ta.value.slice(0, end).split('\n').length,
        });
      };

      React.useEffect(() => {
        if (!file) return;
        setErr(null); setLoaded(false); setSavedAt(null);
        fetch('/dsh-cam/nc?file=' + encodeURIComponent(file)).then((r) => r.json()).then((d) => {
          if (d.ok) {
            const content = d.content ?? '';
            setInitialText(content);
            textRef.current = content;
            setLineCount(content ? content.split('\n').length : 0);
            setLoaded(true);
          } else setErr(d.error || '读取失败');
        }).catch((e) => setErr(String(e)));
      }, [file, version]);

      const save = () => {
        if (!file || !loaded) return;
        const content = currentText();
        textRef.current = content;
        setBusy(true); setErr(null);
        post('/dsh-cam/save', { file, content })
          .then((d) => {
            if (d.ok) { setSavedAt(new Date().toLocaleTimeString()); setErr(null); }
            else setErr(d.error || '保存失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      };

      // 直接跳转到该 NC 文件对应的刀路视图（等价于「返回」+ 单击该文件名，不保存、不进入保存中状态）
      const viewToolpath = () => {
        setBusy(false); setErr(null);
        if (typeof onViewToolpath === 'function') onViewToolpath();
        else if (typeof onClose === 'function') onClose();
      };

      // ---- 查找（Ctrl+F / Cmd+F） ----
      const openFind = React.useCallback(() => {
        setFindOpen(true);
        setFindQuery('');
        setFindCount(0);
        setTimeout(() => { if (findRef.current) findRef.current.focus(); }, 0);
      }, []);
      const closeFind = React.useCallback(() => { setFindOpen(false); setFindQuery(''); setFindCount(0); }, []);
      const doFind = React.useCallback((dir) => {
        const ta = taRef.current;
        if (!ta || !findQuery) return;
        const q = findQuery;
        const text = ta.value;
        const cur = dir < 0 ? ta.selectionStart : ta.selectionEnd;
        let idx;
        if (dir < 0) {
          idx = text.lastIndexOf(q, Math.max(0, cur - 1));
          if (idx < 0) idx = text.lastIndexOf(q);
        } else {
          idx = text.indexOf(q, cur);
          if (idx < 0) idx = text.indexOf(q);
        }
        if (idx >= 0) {
          ta.focus();
          ta.setSelectionRange(idx, idx + q.length);
          ta.scrollTop = text.slice(0, idx).split('\n').length * 20 - ta.clientHeight / 2;
        }
        // 统计匹配次数
        let n = 0, pos = 0;
        while ((pos = text.indexOf(q, pos)) !== -1) { n++; pos += q.length; }
        setFindCount(n);
      }, [findQuery]);

      const onKey = (e) => {
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
        // Ctrl/Cmd+S 保存
        if (mod && k === 's') { e.preventDefault(); e.stopPropagation(); save(); return; }
        // Ctrl/Cmd+F 查找
        if (mod && k === 'f') { e.preventDefault(); e.stopPropagation(); openFind(); return; }
        // Ctrl/Cmd+A 全选：阻止冒泡，避免宿主全局「全选」处理器干扰导致卡死
        if (mod && k === 'a') { e.preventDefault(); e.stopPropagation(); const ta = taRef.current; if (ta) { ta.focus(); ta.select(); } return; }
        if (e.key === 'Escape') {
          if (findOpen) { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
          e.preventDefault(); e.stopPropagation(); onClose();
        }
      };
      const onFindKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doFind(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
      };

      const onChange = (e) => {
        const v = e.target.value;
        textRef.current = v;
        // 仅在行数变化时更新状态；用 indexOf 计数换行，避免大文件 split 出巨量数组。
        let n = 1, p = 0;
        while ((p = v.indexOf('\n', p)) !== -1) { n++; p++; }
        setLineCount((prev) => (prev === n ? prev : n));
      };

      return h('div', { style: { flex: 1, minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)' } },
        h('div', { style: ED_HEAD },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: file },
            '编辑 NC：' + (file || '')),
          savedAt ? h('span', { style: { fontSize: 12, fontWeight: 600, color: '#ffffff', background: '#16a34a', padding: '2px 10px', borderRadius: 10, flex: 'none', lineHeight: '18px' } }, '✓ 已保存 ' + savedAt) : null,
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', flex: 'none' } }, lineCount + ' 行'),
          h('button', { style: edBtnPrimary, onClick: save, disabled: busy || !loaded, title: '保存并刷新刀路 (Ctrl/Cmd+S)' }, busy ? '保存中…' : '保存'),
          h('button', { style: edBtnGhost, onClick: openFind, title: '查找 (Ctrl/Cmd+F)' }, '查找'),
          h('button', { style: edBtnGhost, onClick: viewToolpath, title: '查看该 NC 文件对应的刀路' }, '查看刀路'),
          h('button', { style: edBtnDanger, onClick: onClose, title: '返回刀路视图' }, '返回')),
        err ? h('div', { style: { padding: '8px 14px', color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12, borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)' } }, '错误：' + err) : null,
        findOpen ? h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1, #eceff3)', background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)' },
        },
          h('input', {
            ref: findRef, style: edFindInput,
            value: findQuery, placeholder: '查找…（Enter 下一个 · Shift+Enter 上一个）',
            onChange: (e) => setFindQuery(e.target.value), onKeyDown: onFindKey,
          }),
          findCount > 0 ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)', flex: 'none' } }, findCount + ' 处') : null,
          h('button', { style: { ...edBtnGhost, fontSize: 11, padding: '2px 8px' }, onClick: () => doFind(-1), title: '上一个 (Shift+Enter)' }, '↑'),
          h('button', { style: { ...edBtnGhost, fontSize: 11, padding: '2px 8px' }, onClick: () => doFind(1), title: '下一个 (Enter)' }, '↓'),
          h('button', { style: { ...edBtnGhost, fontSize: 11, padding: '2px 8px' }, onClick: closeFind, title: '关闭查找 (Esc)' }, '✕'))
        : null,
        h('textarea', {
          ref: taRef, key: version, style: edTextarea, defaultValue: initialText, spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off',
          placeholder: loaded ? '' : '加载中…',
          onChange: onChange, onKeyDown: onKey, onContextMenu: onContextMenu,
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
            onClick: () => { doQuote(menu.sel, menu.startLine, menu.endLine, menu.selStart, menu.selEnd); setMenu(null); },
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

      // 点击会话中的 NC 文件名时：不要在本 tab 内打开编辑器，而是转发给浮动面板
      // （QizhouCNC_CAM 编辑界面）打开——这样「查看刀路/返回」能回到真正的刀路视图。
      React.useEffect(() => {
        if (file) {
          try {
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_NC_EVENT, { detail: { file } }));
          } catch (e) { /* ignore */ }
          const t = setTimeout(() => { try { if (actions && typeof actions.close === 'function') actions.close(); } catch (e) { /* ignore */ } }, 0);
          return () => clearTimeout(t);
        }
      }, [file, actions]);

      if (!parsed || !file) {
        return h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 13 } },
          '无法解析该 NC 文件地址');
      }
      return h('div', { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 13 } },
        '正在 QizhouCNC_CAM 中打开：' + basenameOf(file));
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
    const input = { flex: 1, minWidth: 0, padding: '6px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6, background: '#ffffff', color: '#111827' };

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
      // 模型视窗 / 刀路视窗切换 + 3D 模型 + 选面/选边标注
      const [viewMode, setViewMode] = React.useState('toolpath'); // 'toolpath' | 'model'
      const [modelScene, setModelScene] = React.useState(null);
      const [modelSelected, setModelSelected] = React.useState(null); // { kind, id, center?, area?, points? } 主选中项
      // 多选（Shift+点击）：同一类特征的多条选中 { kind, id, center?, area?, points? }
      const [modelSelectedSet, setModelSelectedSet] = React.useState([]);
      // 相同特征提示：检测到当前面/边有 N 个相同特征时弹出，可一键「一起标注」
      const [similarPrompt, setSimilarPrompt] = React.useState(null); // { kind, ids:[], count, label }
      const [annotating, setAnnotating] = React.useState(false); // 双击后进入标注命名态（显示命名输入框）
      const [modelLoading, setModelLoading] = React.useState(false);
      const [modelFeatures, setModelFeatures] = React.useState([]);
      const [featureName, setFeatureName] = React.useState('');
      const [featureNote, setFeatureNote] = React.useState('');
      // 二次修改：正在编辑的标注 id（null=新建）；双击标注项进入重命名态
      const [editingFeatureId, setEditingFeatureId] = React.useState(null);
      // 模型视窗的旋转轴心（默认为 null → 用模型包围盒中心）；用户可设自定义轴心
      const [modelPivot, setModelPivot] = React.useState(null);
      // 主体（被加工零件）的位移/旋转，与夹具/毛坯同款 transform
      const [mainTransform, setMainTransform] = React.useState(null); // { translate:[x,y,z], rotate:[rx,ry,rz] } | null
      const [mainTf, setMainTf] = React.useState({ translate: [0, 0, 0], rotate: [0, 0, 0] }); // 输入框暂存
      // 点击左侧标注列表项 → 定位到模型对应面/边并高亮（{ kind, id }）
      const [locateTarget, setLocateTarget] = React.useState(null);
      // 夹具 / 毛坯（额外叠加到模型视窗的模型，供 AI 了解夹持与毛坯形状）
      const [assets, setAssets] = React.useState([]);        // [{ id, name, role:'fixture'|'blank', path }]
      const [assetScenes, setAssetScenes] = React.useState({}); // id -> scene
      const [assetName, setAssetName] = React.useState('');
      const [assetPath, setAssetPath] = React.useState('');
      const [assetRole, setAssetRole] = React.useState('blank'); // 'blank' | 'fixture'
      // 夹具/毛坯位姿调整：选中的 asset id + 其 translate(mm)/rotate(deg)
      const [editingAssetId, setEditingAssetId] = React.useState(null);
      const [assetTransform, setAssetTransform] = React.useState({ translate: [0, 0, 0], rotate: [0, 0, 0] });
      // 打赏二维码弹窗
      const [showReward, setShowReward] = React.useState(false);
      // 打赏二维码双击放大（点击二维码图片放大显示）
      const [rewardZoomed, setRewardZoomed] = React.useState(false);
      // 诊断日志弹窗 + 日志内容（导出/查看日志，定位问题用）
      const [showLog, setShowLog] = React.useState(false);
      const [logInfo, setLogInfo] = React.useState(null); // { file, size, lines, text } | null
      const [logLoading, setLogLoading] = React.useState(false);
      // 插件支持的 skill 列表（主界面「支持技能」弹窗展示）
      const [skillsList, setSkillsList] = React.useState([]); // [{ name, title, description }]
      // 支持技能弹窗：开关 + 当前查看详情的 skill（含 content 正文）
      const [showSkills, setShowSkills] = React.useState(false);
      const [skillDetail, setSkillDetail] = React.useState(null); // { name, title, description, content } | null
      // 版本更新检查（右下角：版本号 / 更新提醒 / 手动更新）
      const [versionInfo, setVersionInfo] = React.useState(null); // { current, latest, updateAvailable }
      const [updating, setUpdating] = React.useState(false); // 是否正在执行更新
      // 模型视窗放大（全屏遮罩显示整个模型操作区：标注列表 + 视窗 + 轴心 + 设置面板 + 标注输入 + 夹具/毛坯）
      const [modelMaximized, setModelMaximized] = React.useState(false);
      // 底部设置区（主体零件位移/旋转 + 夹具/毛坯）折叠/展开
      const [setupCollapsed, setSetupCollapsed] = React.useState(false);
      // FreeCAD 自动下载状态（未安装 FreeCAD 时展示进度并触发下载）
      const [fcStatus, setFcStatus] = React.useState(null); // { phase:'idle'|'downloading'|'extracting'|'done'|'error', ... }
      const [fcChecking, setFcChecking] = React.useState(false);
      const panelRef = React.useRef(null);
      const assetFileRef = React.useRef(null); // 隐藏的 <input type=file>，用于原生「打开文件」对话框选择 STEP
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

      // ESC 关闭全屏/弹窗：模型视窗放大 → 二维码放大 → 打赏弹窗 → 日志弹窗 → 技能弹窗，按优先级逐层退出。
      React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          if (modelMaximized) { setModelMaximized(false); return; }
          if (rewardZoomed) { setRewardZoomed(false); return; }
          if (showReward) { setShowReward(false); return; }
          if (showLog) { setShowLog(false); return; }
          if (showSkills) { setShowSkills(false); setSkillDetail(null); return; }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [modelMaximized, rewardZoomed, showReward, showLog, showSkills]);

      const post = React.useCallback((path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()), []);

      const reveal = React.useCallback((filePath) => {
        post('/dsh-cam/reveal', { file: filePath }).then((d) => { if (!d.ok) setErr(d.error || '打开失败'); }).catch((e) => setErr(String(e)));
      }, [post]);

      // 打开日志弹窗并拉取最近日志（技能列表由 loadSkills 挂载时已拉取）
      const openLog = React.useCallback(() => {
        setShowLog(true);
        setLogLoading(true);
        fetch('/dsh-cam/log?lines=2000')
          .then((r) => r.json())
          .then((d) => { setLogInfo(d && d.ok ? d : null); })
          .catch(() => setLogInfo(null))
          .finally(() => setLogLoading(false));
      }, []);

      // 清空日志（主文件；备份 .1 保留）
      const clearLog = React.useCallback(() => {
        post('/dsh-cam/log', {})
          .then(() => openLog())
          .catch((e) => setErr(String(e)));
      }, [post, openLog]);

      // 把日志下载为 .log 文件
      const downloadLog = React.useCallback(() => {
        const text = (logInfo && logInfo.text) || '';
        if (!text) { setErr('暂无日志内容可导出'); return; }
        try {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'dsh-cam-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) { setErr(String(e)); }
      }, [logInfo]);

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

      // 点击 STEP 模型 → 自动网格化并切到「模型视窗」显示
      const loadModel = React.useCallback((modelPath) => {
        const p = (modelPath || '').trim();
        if (!p) { setErr('请先输入或选择一个 STEP 模型路径'); return; }
        setBusy(true); setErr(null); setModelLoading(true);
        post('/dsh-cam/model', { model: p })
          .then((d) => {
            // /dsh-cam/model returns the tessellated scene directly ({ok,file,bounds,faces,edges})
            if (d && d.ok && Array.isArray(d.faces)) {
              setModelScene(d);
              setModelSelected(null);
              setModelSelectedSet([]);
              setSimilarPrompt(null);
              setLocateTarget(null);
              setAnnotating(false);
              setMainTransform(null);
              setMainTf({ translate: [0, 0, 0], rotate: [0, 0, 0] });
              setViewMode('model');
              setModelFile(p);
              loadFeatures(p);
              loadAssets(p);
            } else {
              setErr((d && d.error) || '模型加载失败');
            }
          })
          .catch((e) => setErr(String(e)))
          .finally(() => { setBusy(false); setModelLoading(false); });
      }, [post]);

      // ---- 多选（Shift+点击）与相同特征检测 ----
      // 选中集合的稳定键：kind:id
      const selKey = (s) => s.kind + ':' + s.id;
      // 在场景里找某个 kind:id 对应的面/边详情
      const sceneHitOf = React.useCallback((kind, id) => {
        if (!modelScene) return null;
        if (kind === 'face') return modelScene.faces.find((x) => x.id === id) || null;
        return modelScene.edges.find((x) => x.id === id) || null;
      }, [modelScene]);

      // 计算与某面/边「相同特征」的其它面/边 id 列表（基于 tessellation 出的 shapeKey）。
      const similarIdsOf = React.useCallback((kind, id) => {
        if (!modelScene) return [];
        const arr = kind === 'face' ? modelScene.faces : modelScene.edges;
        const target = arr.find((x) => x.id === id);
        if (!target || !target.shapeKey) return [];
        return arr.filter((x) => x.shapeKey && x.shapeKey === target.shapeKey).map((x) => x.id);
      }, [modelScene]);

      // 统一处理「选中」：单点=单选；Shift+点击=切换多选（限定同一 kind）。
      // 返回是否进入多选态（选中集合 > 1）。
      const applySelection = React.useCallback((sel, addToMulti) => {
        if (!sel) return;
        setModelSelected(sel);
        setAnnotating(false);
        setEditingFeatureId(null);
        if (addToMulti) {
          // Shift 多选：同一 kind 内切换
          setModelSelectedSet((prev) => {
            const sameKind = prev.filter((s) => s.kind === sel.kind);
            const idx = sameKind.findIndex((s) => selKey(s) === selKey(sel));
            if (idx >= 0) return sameKind.filter((s) => selKey(s) !== selKey(sel));
            return [...sameKind, sel];
          });
        } else {
          setModelSelectedSet([sel]);
        }
        setSimilarPrompt(null);
      }, []);

      // 选中后检测相同特征：若该面/边有 >1 个相同 shapeKey，弹出「一起标注」提示。
      const detectSimilar = React.useCallback((kind, id) => {
        const ids = similarIdsOf(kind, id);
        if (ids.length > 1) {
          const n = ids.length;
          const label = kind === 'face' ? '个相同特征的面' : '条相同特征的边';
          setSimilarPrompt({ kind, ids, count: n, label });
        } else {
          setSimilarPrompt(null);
        }
      }, [similarIdsOf]);

      // 查询 FreeCAD 自动下载/安装状态
      const checkFcStatus = React.useCallback(() => {
        fetch('/dsh-cam/freecad').then((r) => r.json()).then((d) => {
          if (d && d.ok) setFcStatus(d);
        }).catch(() => {});
      }, []);
      // 触发 FreeCAD 自动下载（官方 GitHub Releases 便携版）
      const startFcDownload = React.useCallback(() => {
        setFcChecking(true);
        post('/dsh-cam/freecad', {})
          .then((d) => { if (d && d.ok) setFcStatus(d); })
          .catch((e) => setErr(String(e)))
          .finally(() => setFcChecking(false));
      }, [post]);
      // 下载中/中断恢复时轮询进度
      React.useEffect(() => {
        if (fcStatus && (fcStatus.phase === 'downloading' || fcStatus.phase === 'extracting' || fcStatus.phase === 'interrupted')) {
          const t = setInterval(() => { fetch('/dsh-cam/freecad').then((r) => r.json()).then((d) => { if (d && d.ok) setFcStatus(d); }).catch(() => {}); }, 1500);
          return () => clearInterval(t);
        }
      }, [fcStatus && fcStatus.phase]);

      // 挂载时查询一次 FreeCAD 状态（未安装时展示下载入口）
      React.useEffect(() => { checkFcStatus(); }, [checkFcStatus]);

      // 查询本插件版本与 npm 最新版本（用于右下角更新提醒）
      const checkVersion = React.useCallback(() => {
        fetch('/dsh-cam/version')
          .then((r) => r.json())
          .then((d) => { if (d && d.ok) setVersionInfo({ current: d.current, latest: d.latest, updateAvailable: !!d.updateAvailable }); })
          .catch(() => {});
      }, []);
      React.useEffect(() => { checkVersion(); }, [checkVersion]);

      // 拉取插件支持的 skill 列表（主界面 footer「支持技能」）
      // 后端路由不可用（未重启）时回退到静态列表，避免一直显示「…」。
      const FALLBACK_SKILLS = [
        { name: 'cnc-process-card', title: 'CNC 工艺卡', description: '生成 CNC 加工 MD 工艺卡' },
        { name: 'cnc-auto-annotate', title: 'CNC 自动标注', description: '按工艺卡自动标注刀具/坐标系' },
      ];
      const loadSkills = React.useCallback(() => {
        fetch('/dsh-cam/skills')
          .then((r) => r.json())
          .then((d) => { if (d && d.ok && Array.isArray(d.skills) && d.skills.length) setSkillsList(d.skills); else setSkillsList(FALLBACK_SKILLS); })
          .catch(() => setSkillsList(FALLBACK_SKILLS));
      }, []);
      React.useEffect(() => { loadSkills(); }, [loadSkills]);

      // 打开「支持技能」弹窗（列表）
      const openSkills = React.useCallback(() => {
        setShowSkills(true);
        setSkillDetail(null);
        loadSkills();
      }, [loadSkills]);

      // 查看单个 skill 的完整方法详情（弹窗内展开正文）
      const viewSkillDetail = React.useCallback((name) => {
        fetch('/dsh-cam/skills?name=' + encodeURIComponent(name))
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok && d.skill) setSkillDetail(d.skill);
            else {
              // 路由不可用（未重启）：用列表里的描述兜底
              const fallback = FALLBACK_SKILLS.find((s) => s.name === name);
              if (fallback) setSkillDetail({ ...fallback, content: '（完整方法内容需重启后加载）\n\n' + fallback.description });
            }
          })
          .catch(() => {
            const fallback = FALLBACK_SKILLS.find((s) => s.name === name);
            if (fallback) setSkillDetail({ ...fallback, content: '（完整方法内容需重启后加载）\n\n' + fallback.description });
          });
      }, []);

      // 把当前查看的技能方法引用到对话框（复用 NcEditor 同款 inputHub 解析逻辑）
      const quoteSkill = React.useCallback(() => {
        if (!skillDetail) return;
        const quote = '【技能引用】' + (skillDetail.title || skillDetail.name) + '（调用名：' + skillDetail.name + '）\n\n' + (skillDetail.content || skillDetail.description || '');
        let inputHub = null;
        if (appCtx) {
          try { const conv = appCtx.get('conversation'); if (conv && conv.input && typeof conv.input.shell === 'function') inputHub = conv.input; } catch (e) {}
          if (!inputHub) {
            try {
              const sessions = appCtx.get('sessions');
              if (sessions && typeof sessions.scope === 'function' && sessionId) {
                const actx = sessions.scope(sessionId);
                if (actx) { const conv = actx.get('conversation'); if (conv && conv.input && typeof conv.input.shell === 'function') inputHub = conv.input; }
              }
            } catch (e) {}
          }
        }
        if (!inputHub || typeof inputHub.shell !== 'function') { setErr('对话框服务未就绪，无法引用'); return; }
        try {
          const shell = inputHub.shell(sessionId);
          if (!shell) { setErr('未能定位到当前会话的输入框'); return; }
          let ok = false;
          if (typeof shell.insertQuote === 'function') ok = shell.insertQuote(quote);
          if (!ok && typeof shell.setDraft === 'function') { shell.setDraft(quote); ok = true; }
          if (!ok) setErr('引用失败：当前输入框不可编辑');
        } catch (e) { setErr('引用失败：' + (e && e.message ? e.message : String(e))); }
      }, [skillDetail, sessionId]);

      // 点击「更新」：通过 dshmarket 的公共更新 API 触发更新（同源、带浏览器会话 cookie）
      const doUpdate = React.useCallback(() => {
        if (!versionInfo || updating) return;
        setUpdating(true); setErr(null);
        fetch('/dsh-market/api/v1/updates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packageName: 'dsh-qizhoucnc-cam' }),
        })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              const msg = (d && (d.error || d.failure?.message)) || ('更新请求失败（HTTP ' + r.status + '）');
              setErr('更新失败：' + msg + '。可前往「设置 → 插件市场」手动更新。');
              return;
            }
            // 202 = 已排队/进行中；200 = 已完成。随后刷新版本信息。
            if (d.operation && d.operation.operationId) {
              const opId = d.operation.operationId;
              const poll = () => {
                fetch('/dsh-market/api/v1/operations?operationId=' + encodeURIComponent(opId))
                  .then((r2) => r2.json())
                  .then((o) => {
                    const op = o && o.operation;
                    if (!op) return;
                    if (op.state === 'succeeded') {
                      setErr(null); setVersionInfo((prev) => prev ? { ...prev, updateAvailable: false } : prev);
                      setTimeout(checkVersion, 1500);
                      if (op.outcome && op.outcome.restartRequired) setErr('已更新到 ' + (op.installedVersion || '新版本') + '，重启 DSH 后生效。');
                      else if (op.outcome && op.outcome.refreshRequired) { setErr('已更新到 ' + (op.installedVersion || '新版本') + '，已生效。'); }
                      else setErr('已更新到 ' + (op.installedVersion || '新版本') + '。');
                    } else if (op.state === 'failed') {
                      setErr('更新失败：' + ((op.failure && op.failure.message) || '未知错误'));
                    } else if (op.state === 'cancelled') {
                      setErr('更新已取消。');
                    } else {
                      setTimeout(poll, 1200);
                    }
                  })
                  .catch(() => setTimeout(poll, 1500));
              };
              poll();
            } else {
              setVersionInfo((prev) => prev ? { ...prev, updateAvailable: false } : prev);
              setTimeout(checkVersion, 1500);
            }
          })
          .catch((e) => setErr('更新失败：' + String(e)))
          .finally(() => setUpdating(false));
      }, [versionInfo, updating, checkVersion]);

      // 拉取该模型已写入的「识别文件」标注
      const loadFeatures = React.useCallback((modelPath) => {
        fetch('/dsh-cam/feature?model=' + encodeURIComponent(modelPath))
          .then((r) => r.json())
          .then((d) => { if (d.ok && Array.isArray(d.features)) setModelFeatures(d.features); })
          .catch(() => {});
      }, []);

      // 把当前选中的面/边作为「加工位置」标注，命名后写入识别文件。
      // 支持批量：refIds 存在时一次写入多条（Shift 多选 或「一起标注」）。
      const addFeature = React.useCallback(() => {
        if (!modelSelected) { setErr('请先在模型视窗中点击一个面或边线'); return; }
        const name = featureName.trim();
        if (!name) { setErr('请为这个加工位置填写名称'); return; }
        setBusy(true); setErr(null);
        // 批量标注：优先取 similarPrompt.ids 或 modelSelectedSet 的 refIds
        const multi = similarPrompt && similarPrompt.kind === modelSelected.kind
          ? similarPrompt.ids
          : (modelSelectedSet.length > 1 && modelSelectedSet.every((s) => s.kind === modelSelected.kind)
              ? modelSelectedSet.map((s) => s.id)
              : null);
        const body = {
          model: modelFile,
          name,
          kind: modelSelected.kind,
          refId: modelSelected.id,
          note: featureNote.trim(),
        };
        if (multi && multi.length > 1) body.refIds = multi;
        // 二次修改：若正在编辑某条已有标注，走 update；否则新增
        if (editingFeatureId) body.op = 'update', body.id = editingFeatureId;
        post('/dsh-cam/feature', body)
          .then((d) => {
            if (d.ok && Array.isArray(d.features)) {
              setModelFeatures(d.features);
              setFeatureName('');
              setFeatureNote('');
              setEditingFeatureId(null);
              setAnnotating(false);
              setModelSelected(null);
              setModelSelectedSet([]);
              setSimilarPrompt(null);
            } else setErr(d.error || '标注写入失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      }, [post, modelFile, modelSelected, modelSelectedSet, similarPrompt, featureName, featureNote, editingFeatureId]);

      // 从已有标注列表开始「二次修改」（重命名 / 改备注 / 重选目标）
      const startEditFeature = React.useCallback((f) => {
        setModelSelected({ kind: f.kind, id: f.refId });
        // 批量特征：恢复多选集合，让「已选 N 个」与高亮一致
        if (Array.isArray(f.refIds) && f.refIds.length > 1) {
          setModelSelectedSet(f.refIds.map((id) => ({ kind: f.kind, id })));
        } else {
          setModelSelectedSet([]);
        }
        setSimilarPrompt(null);
        setFeatureName(f.name || '');
        setFeatureNote(f.note || '');
        setEditingFeatureId(f.id);
        setAnnotating(true);
      }, []);

      // 删除一条已有标注
      const removeFeature = React.useCallback((f) => {
        if (!modelFile) return;
        setBusy(true); setErr(null);
        post('/dsh-cam/feature', { model: modelFile, op: 'delete', id: f.id })
          .then((d) => { if (d.ok && Array.isArray(d.features)) setModelFeatures(d.features); else setErr(d.error || '删除失败'); })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      }, [post, modelFile]);

      // ---- 夹具 / 毛坯（上传后叠加到模型视窗，供 AI 了解夹持与毛坯） ----
      const loadAssets = React.useCallback((modelPath) => {
        if (!modelPath) return;
        fetch('/dsh-cam/assets?model=' + encodeURIComponent(modelPath))
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok || !Array.isArray(d.assets)) return;
            setAssets(d.assets);
            // 逐个拉取已网格化的夹具/毛坯场景
            for (const a of d.assets) {
              fetch('/dsh-cam/asset-scene?id=' + encodeURIComponent(a.id) + '&model=' + encodeURIComponent(modelPath))
                .then((r2) => r2.json())
                .then((d2) => {
                  if (d2.ok && d2.scene) setAssetScenes((prev) => ({ ...prev, [a.id]: d2.scene }));
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      }, []);
      const addAsset = React.useCallback(() => {
        const p = assetPath.trim();
        if (!p) { setErr('请选择夹具/毛坯的 STEP 模型文件'); return; }
        if (!modelFile) { setErr('请先加载主模型（零件）'); return; }
        setBusy(true); setErr(null);
        post('/dsh-cam/assets', { model: modelFile, name: assetName.trim(), role: assetRole, path: p })
          .then((d) => {
            if (d.ok && Array.isArray(d.assets)) {
              setAssets(d.assets);
              setAssetName('');
              setAssetPath('');
              // 重新拉取场景（新增的这条可能刚网格化完成）
              loadAssets(modelFile);
            } else setErr(d.error || '上传失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      }, [post, modelFile, assetName, assetPath, assetRole, loadAssets]);
      // 打开原生文件对话框选 STEP，读字节 POST 到 host 存盘，返回绝对路径填入 assetPath
      const pickAssetFile = React.useCallback(() => {
        const el = assetFileRef.current;
        if (el) el.click();
      }, []);
      const onAssetFileChosen = React.useCallback((e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const name = file.name || 'upload.step';
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result || '').split(',')[1] || '';
          if (!base64) { setErr('读取文件失败'); return; }
          setBusy(true); setErr(null);
          post('/dsh-cam/upload', { name, data: base64 })
            .then((d) => {
              if (d.ok && d.path) {
                setAssetPath(d.path);
                if (!assetName.trim()) setAssetName(name.replace(/\.[^.]+$/, ''));
              } else setErr(d.error || '上传失败');
            })
            .catch((err) => setErr(String(err)))
            .finally(() => setBusy(false));
        };
        reader.onerror = () => setErr('读取文件失败');
        reader.readAsDataURL(file);
        e.target.value = '';
      }, [post, assetName]);
      const removeAsset = React.useCallback((a) => {
        if (!modelFile) return;
        setBusy(true); setErr(null);
        post('/dsh-cam/assets', { model: modelFile, op: 'delete', id: a.id })
          .then((d) => {
            if (d.ok && Array.isArray(d.assets)) {
              setAssets(d.assets);
              setAssetScenes((prev) => { const n = { ...prev }; delete n[a.id]; return n; });
            } else setErr(d.error || '删除失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      }, [post, modelFile]);
      // 夹具/毛坯位姿调整：选中某条后，编辑 translate(mm)/rotate(deg) 并保存
      const startEditAsset = React.useCallback((a) => {
        setEditingAssetId(a.id);
        const t = a.transform || { translate: [0, 0, 0], rotate: [0, 0, 0] };
        setAssetTransform({
          translate: Array.isArray(t.translate) ? t.translate.slice(0, 3) : [0, 0, 0],
          rotate: Array.isArray(t.rotate) ? t.rotate.slice(0, 3) : [0, 0, 0],
        });
      }, []);
      const saveAssetTransform = React.useCallback(() => {
        if (!modelFile || !editingAssetId) return;
        setBusy(true); setErr(null);
        post('/dsh-cam/assets', { model: modelFile, op: 'transform', id: editingAssetId, transform: assetTransform })
          .then((d) => {
            if (d.ok && Array.isArray(d.assets)) {
              setAssets(d.assets);
              setEditingAssetId(null);
              // 更新叠加渲染用的 transform（asset-scene 里已带 transform，重拉即可）
              loadAssets(modelFile);
            } else setErr(d.error || '保存位姿失败');
          })
          .catch((e) => setErr(String(e)))
          .finally(() => setBusy(false));
      }, [post, modelFile, editingAssetId, assetTransform, loadAssets]);
      const tfInput = () => ({ ...input, width: 58, padding: '4px 6px', fontSize: 12, textAlign: 'center' });
      const setTf = (axis, idx, val) => setAssetTransform((prev) => {
        const n = prev[axis].slice();
        n[idx] = Number(val) || 0;
        return { ...prev, [axis]: n };
      });
      // 主体（被加工零件）位姿：临时输入 + 应用
      const setMainTfAxis = (axis, idx, val) => setMainTf((prev) => {
        const n = prev[axis].slice();
        n[idx] = Number(val) || 0;
        return { ...prev, [axis]: n };
      });
      const applyMainTransform = React.useCallback(() => {
        setMainTransform({ translate: mainTf.translate.slice(0, 3), rotate: mainTf.rotate.slice(0, 3) });
      }, [mainTf]);
      const resetMainTransform = React.useCallback(() => {
        setMainTransform(null);
        setMainTf({ translate: [0, 0, 0], rotate: [0, 0, 0] });
      }, []);

      const ncCount = files.nc.length;

      // feature 4: 右栏 tab 转发「打开 NC」→ 浮动面板进入编辑界面（并展开面板）
      React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const onOpenNc = (e) => {
          const p = e && e.detail && typeof e.detail.file === 'string' ? e.detail.file : null;
          if (!p) return;
          setOpen(true);
          setEditingFile(p);
        };
        window.addEventListener(OPEN_NC_EVENT, onOpenNc);
        return () => window.removeEventListener(OPEN_NC_EVENT, onOpenNc);
      }, []);

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
          onClick: () => loadModel(f.path),
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
              'STEP 模型' + (files.steps.length > 0 ? '（点击查看，将在模型视窗显示。）' : '')),
            files.steps.length === 0
              ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '工作区未发现 .step/.stp 文件')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 90, overflow: 'auto' } }, stepItems),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              h('input', { style: input, value: modelFile, placeholder: '或手动输入 STEP 路径', onChange: (e) => setModelFile(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') loadModel(modelFile); } }),
              h('button', { style: btnPrimary, onClick: () => loadModel(modelFile), disabled: busy }, modelLoading ? '加载中…' : '加载模型')),
            // FreeCAD 未安装时的自动下载入口（Windows / Linux 便携版）
            fcStatus && fcStatus.found === false && fcStatus.phase !== 'downloading' && fcStatus.phase !== 'extracting' && fcStatus.phase !== 'done'
              ? h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, padding: '8px 10px', borderRadius: 8,
                    background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)',
                  },
                },
                  h('span', { style: { flex: 1, fontSize: 11, color: '#92400e' } },
                    fcStatus.phase === 'error' ? 'FreeCAD 自动下载失败：' + (fcStatus.error || '未知错误')
                    : fcStatus.phase === 'interrupted' ? '下载已中断（已下载 ' + Math.round((fcStatus.downloaded || 0) / 1024 / 1024) + ' MB），可继续下载。'
                    : '未检测到 FreeCAD，加载/生成需要它。'),
                  fcStatus.phase === 'error'
                    ? h('button', { style: btnPrimary, onClick: startFcDownload, disabled: fcChecking }, fcChecking ? '准备中…' : '重试下载')
                    : h('button', { style: btnPrimary, onClick: startFcDownload, disabled: fcChecking }, fcChecking ? '准备中…' : (fcStatus.phase === 'interrupted' ? '继续下载' : '自动下载 FreeCAD')))
              : null,
            fcStatus && (fcStatus.phase === 'downloading' || fcStatus.phase === 'extracting')
              ? h('div', {
                  style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' },
                },
                  h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-primary, #111)' } }, fcStatus.phase === 'downloading' ? '正在下载 FreeCAD 便携版…' : '正在解压 FreeCAD…'),
                  fcStatus.phase === 'downloading' && typeof fcStatus.total === 'number' && fcStatus.total > 0
                    ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                        Math.round(((fcStatus.downloaded || 0) / fcStatus.total) * 100) + '%（' + Math.round((fcStatus.downloaded || 0) / 1024 / 1024) + ' / ' + Math.round(fcStatus.total / 1024 / 1024) + ' MB）')
                    : null)
              : null,
            fcStatus && fcStatus.phase === 'done' && fcStatus.bin
              ? h('div', { style: { fontSize: 11, color: '#16a34a', marginTop: 6 } }, '✓ FreeCAD 已就绪：' + basenameOf(fcStatus.bin))
              : null),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 0' } },
            h('button', {
              onClick: () => setViewMode('toolpath'),
              style: {
                ...btn, fontWeight: viewMode === 'toolpath' ? 700 : 400,
                borderColor: viewMode === 'toolpath' ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)',
                color: viewMode === 'toolpath' ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111)',
              },
            }, '刀路视窗'),
            h('button', {
              onClick: () => setViewMode('model'),
              style: {
                ...btn, fontWeight: viewMode === 'model' ? 700 : 400,
                borderColor: viewMode === 'model' ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)',
                color: viewMode === 'model' ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111)',
              },
            }, '模型视窗'),
            h('span', { style: { flex: 1 } }),
            viewMode === 'model' && modelScene
              ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, modelFile ? basenameOf(modelFile) : '') : null),
          h('div', { style: { flex: 1, overflow: 'hidden', padding: 10, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            err ? h('div', { style: { padding: 8, color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: 12, marginBottom: 8 } }, '错误：' + err) : null,
            viewMode === 'model'
              ? h('div', {
                  style: {
                    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', gap: 8,
                    // 放大：把整个模型操作区（标注列表 + 视窗 + 轴心 + 设置面板 + 标注输入 + 夹具/毛坯）
                    // 原样铺到全屏，布局保持不变；position:fixed 相对视口定位，不受面板 overflow 裁剪。
                    ...(modelMaximized ? {
                      position: 'fixed', inset: 0, zIndex: 3100,
                      background: 'var(--dsw-alias-bg-base, #fff)',
                      padding: 16, boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
                    } : {}),
                  },
                },
                  // 放大态：右上角浮动「还原」按钮 + 顶部标题条（点击遮罩语义一致）
                  modelMaximized ? h('div', {
                    style: {
                      position: 'absolute', top: 12, right: 12, zIndex: 3101,
                      display: 'flex', alignItems: 'center', gap: 8,
                    },
                  },
                    h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '模型视窗 · 放大'),
                    h('button', {
                      onClick: () => setModelMaximized(false),
                      style: { ...btn, fontSize: 12, padding: '3px 12px', fontWeight: 600 },
                      title: '还原模型视窗',
                    }, '还原')) : null,
                  // 左侧：已标注加工位置列表
                  h('div', { style: { width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', padding: 8, overflow: 'hidden' } },
                    h('div', { style: { fontSize: 11, fontWeight: 700, color: 'var(--dsw-alias-label-primary, #111)', marginBottom: 4 } }, '已标注加工位置'),
                    h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', marginBottom: 6 } }, '供 AI 识别加工'),
                    modelFeatures.length > 0
                      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, overflowY: 'auto' } },
                          modelFeatures.map((f) => h('div', {
                            key: f.id,
                            title: '单击定位到模型 · 双击重命名 · 点击 ✕ 删除',
                            style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', fontSize: 12, borderRadius: 6, background: 'rgba(255,154,61,0.14)', border: '1px solid rgba(249,115,22,0.35)', cursor: 'pointer' },
                            onClick: () => { setLocateTarget({ kind: f.kind, id: f.refId, ids: Array.isArray(f.refIds) && f.refIds.length > 1 ? f.refIds : null }); setSimilarPrompt(null); },
                            onDoubleClick: () => startEditFeature(f),
                          },
                            h('span', { style: { fontSize: 12, color: '#f97316' } }, f.kind === 'face' ? '▨' : '╱'),
                            h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
                              h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
                              h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, (f.kind === 'face' ? '面' : '边') + ' #' + f.refId + (Array.isArray(f.refIds) && f.refIds.length > 1 ? ' ×' + f.refIds.length : '') + (f.note ? ' · ' + f.note : ''))),
                            h('button', {
                              onClick: () => removeFeature(f),
                              title: '删除此标注',
                              style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, fontSize: 11, lineHeight: 1, cursor: 'pointer', borderRadius: '50%', border: 'none', background: 'transparent', color: '#f97316', padding: 0 },
                            }, '✕'))))
                      : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', textAlign: 'center', padding: '12px 0' } }, '暂无标注\n双击面/边线添加')),
                  // 右侧：模型视窗 + 轴心 + 标注输入
                  h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
                    h(ModelViewer3D, {
                      scene: modelScene, selected: modelSelected, selectedSet: modelSelectedSet, pivot: modelPivot, features: modelFeatures, locate: locateTarget,
                      transform: mainTransform,
                      maximized: modelMaximized,
                      onToggleMaximize: () => setModelMaximized((v) => !v),
                      overlays: assets.filter((a) => assetScenes[a.id]).map((a) => ({ asset: a, scene: assetScenes[a.id] })),
                      onSelect: (sel) => {
                        applySelection(sel, false);
                        detectSimilar(sel.kind, sel.id);
                        setLocateTarget(null); // 直接点面/边时清除旧的标签定位高亮
                      },
                      onSelectMulti: (sel) => {
                        // Shift+点击：切换多选；不触发相同特征弹窗（多选本身就是手动选择）
                        applySelection(sel, true);
                        setSimilarPrompt(null);
                        setLocateTarget(null);
                      },
                      onAnnotate: (sel) => {
                        setModelSelected(sel);
                        setModelSelectedSet([sel]);
                        setFeatureName('');
                        setFeatureNote('');
                        setEditingFeatureId(null);
                        setAnnotating(true);
                      },
                      onConfirmMulti: (sel) => {
                        if (sel === null) {
                          // ESC：清空多选
                          setModelSelected(null);
                          setModelSelectedSet([]);
                          setAnnotating(false);
                          return;
                        }
                        if (!Array.isArray(sel) || sel.length < 2) return;
                        // ENTER：把 Shift 多选的面/边集合确认成批量标注，进入命名态
                        setModelSelected(sel[0]);
                        setModelSelectedSet(sel);
                        setSimilarPrompt(null);
                        setFeatureName('');
                        setFeatureNote('');
                        setEditingFeatureId(null);
                        setAnnotating(true);
                      },
                    }),
                    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 } },
                      h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '旋转轴心'),
                      h('button', {
                        onClick: () => setModelPivot(null),
                        style: {
                          ...btn, fontSize: 11, padding: '2px 8px',
                          fontWeight: modelPivot === null ? 700 : 400,
                          borderColor: modelPivot === null ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)',
                        },
                      }, '包围盒中心'),
                      h('button', {
                        onClick: () => setModelPivot([0, 0, 0]),
                        style: {
                          ...btn, fontSize: 11, padding: '2px 8px',
                          fontWeight: modelPivot && modelPivot[0] === 0 && modelPivot[1] === 0 && modelPivot[2] === 0 ? 700 : 400,
                          borderColor: modelPivot && modelPivot[0] === 0 && modelPivot[1] === 0 && modelPivot[2] === 0 ? 'var(--dsw-alias-state-business-primary, #2563eb)' : 'var(--dsw-alias-border-l1, #e5e7eb)',
                        },
                      }, '原点 (0,0,0)'),
                      modelPivot
                        ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
                            '当前 (' + modelPivot.map((v) => Math.round(v)).join(', ') + ')')
                        : null),
                    // ---- 底部设置区折叠开关：折叠/展开 主体零件位移旋转 + 夹具/毛坯 ----
                    h('button', {
                      onClick: () => setSetupCollapsed((v) => !v),
                      title: setupCollapsed ? '展开设置' : '收起设置',
                      style: { ...btn, width: '100%', fontSize: 11, padding: '6px 10px', marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' },
                    },
                      h('span', { style: { fontSize: 11 } }, setupCollapsed ? '▶' : '▼'),
                      '设置面板 ' + (setupCollapsed ? '（已折叠）' : '（主体零件 · 位移旋转 / 夹具 / 毛坯）')),
                    !setupCollapsed && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginTop: 6, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' } },
                      h('div', { style: { fontSize: 11, fontWeight: 700, color: 'var(--dsw-alias-label-primary, #111)' } }, '主体零件 · 位移 / 旋转'),
                      h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '平移(mm) 与 旋转(度)，应用到被加工零件模型'),
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                        h('span', { style: { width: 34 } }, '平移X'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: mainTf.translate[0], onChange: (e) => setMainTfAxis('translate', 0, e.target.value) }),
                        h('span', { style: { width: 34 } }, '平移Y'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: mainTf.translate[1], onChange: (e) => setMainTfAxis('translate', 1, e.target.value) }),
                        h('span', { style: { width: 34 } }, '平移Z'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: mainTf.translate[2], onChange: (e) => setMainTfAxis('translate', 2, e.target.value) })),
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                        h('span', { style: { width: 34 } }, '旋转X'), h('input', { type: 'number', step: 1, style: tfInput(), value: mainTf.rotate[0], onChange: (e) => setMainTfAxis('rotate', 0, e.target.value) }),
                        h('span', { style: { width: 34 } }, '旋转Y'), h('input', { type: 'number', step: 1, style: tfInput(), value: mainTf.rotate[1], onChange: (e) => setMainTfAxis('rotate', 1, e.target.value) }),
                        h('span', { style: { width: 34 } }, '旋转Z'), h('input', { type: 'number', step: 1, style: tfInput(), value: mainTf.rotate[2], onChange: (e) => setMainTfAxis('rotate', 2, e.target.value) })),
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('button', { style: btnPrimary, onClick: applyMainTransform }, '应用到位'),
                        h('button', { style: btn, onClick: resetMainTransform }, '复位'))),
                    // 相同特征提示：检测到当前面/边有 N 个相同特征，可一键一起标注
                    similarPrompt && !annotating
                      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: 8, marginTop: 6, borderRadius: 8, background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)' } },
                          h('span', { style: { flex: 1, fontSize: 11, color: '#92400e' } },
                            '检测到当前' + (similarPrompt.kind === 'face' ? '面' : '边') + '有 ' + similarPrompt.count + ' ' + similarPrompt.label + '，是否一起标注？'),
                          h('button', {
                            onClick: () => {
                              // 一起标注：把相同特征全部加入选中集合，并直接进入命名态
                              const all = similarPrompt.ids.map((id) => ({ kind: similarPrompt.kind, id }));
                              setModelSelectedSet(all);
                              setModelSelected((similarPrompt.kind === 'face'
                                ? modelScene.faces.find((x) => x.id === similarPrompt.ids[0])
                                : modelScene.edges.find((x) => x.id === similarPrompt.ids[0])) || { kind: similarPrompt.kind, id: similarPrompt.ids[0] });
                              setFeatureName('');
                              setFeatureNote('');
                              setEditingFeatureId(null);
                              setAnnotating(true);
                            },
                            style: { ...btnPrimary, fontSize: 11, padding: '3px 10px' },
                          }, '一起标注'),
                          h('button', { onClick: () => setSimilarPrompt(null), style: { ...btn, fontSize: 11, padding: '3px 10px' } }, '忽略'))
                      : null,
                    modelSelected && annotating
                      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginTop: 6, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' } },
                          h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } },
                            (editingFeatureId ? '修改加工位置' : (modelSelected.kind === 'face' ? '标注加工面' : '标注加工边线')) + ' · 已选 #' + modelSelected.id
                            + (modelSelectedSet.length > 1 ? '（共 ' + modelSelectedSet.length + ' 个）' : '')),
                          h('div', { style: { display: 'flex', gap: 6 } },
                            h('input', { style: input, value: featureName, placeholder: '加工位置名称（必填）', onChange: (e) => setFeatureName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') addFeature(); } }),
                            h('input', { style: input, value: featureNote, placeholder: '备注（可选，如钻孔/铣面）', onChange: (e) => setFeatureNote(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') addFeature(); } })),
                          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                            h('button', { style: btnPrimary, onClick: addFeature, disabled: busy }, editingFeatureId ? '保存修改' : '写入识别文件'),
                            h('button', { style: btn, onClick: () => { setModelSelected(null); setModelSelectedSet([]); setAnnotating(false); setEditingFeatureId(null); setSimilarPrompt(null); } }, '取消')))
                      : null,
                    // ---- 上传夹具 / 毛坯（供 AI 了解夹持与毛坯形状） ----
                    !setupCollapsed && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginTop: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)' } },
                      h('div', { style: { fontSize: 11, fontWeight: 700, color: 'var(--dsw-alias-label-primary, #111)' } }, '夹具 / 毛坯'),
                      h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '上传毛坯/夹具 STEP，叠加显示，让 AI 了解夹持与加工区域'),
                      assets.length > 0
                        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                            assets.map((a) => h('div', {
                              key: a.id,
                              style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize: 11, borderRadius: 5, background: a.role === 'fixture' ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.12)', border: '1px solid ' + (a.role === 'fixture' ? 'rgba(79,70,229,0.35)' : 'rgba(5,150,105,0.35)') },
                            },
                              h('span', { style: { fontSize: 12 } }, a.role === 'fixture' ? '🔧' : '🧱'),
                              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary, #111)', cursor: 'pointer' }, onClick: () => startEditAsset(a), title: '点击调整位姿' },
                                (a.name || (a.role === 'fixture' ? '夹具' : '毛坯')) + (a.role === 'fixture' ? '（夹具）' : '（毛坯）')),
                              h('button', {
                                onClick: () => removeAsset(a), title: '删除此夹具/毛坯',
                                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, fontSize: 11, lineHeight: 1, cursor: 'pointer', borderRadius: '50%', border: 'none', background: 'transparent', color: '#f97316', padding: 0 },
                              }, '✕'))))
                        : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '尚未上传夹具/毛坯'),
                      // 位姿调整面板（选中某条夹具/毛坯后出现）
                      editingAssetId
                        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: 6, borderRadius: 6, background: 'var(--dsw-alias-bg-base, #fff)', border: '1px dashed #f59e0b' } },
                            h('div', { style: { fontSize: 11, fontWeight: 700, color: '#b45309' } }, '调整位姿（选中：#' + editingAssetId + '）'),
                            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                              h('span', { style: { width: 34 } }, '平移X'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: assetTransform.translate[0], onChange: (e) => setTf('translate', 0, e.target.value) }),
                              h('span', { style: { width: 34 } }, '平移Y'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: assetTransform.translate[1], onChange: (e) => setTf('translate', 1, e.target.value) }),
                              h('span', { style: { width: 34 } }, '平移Z'), h('input', { type: 'number', step: 0.5, style: tfInput(), value: assetTransform.translate[2], onChange: (e) => setTf('translate', 2, e.target.value) })),
                            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                              h('span', { style: { width: 34 } }, '旋转X'), h('input', { type: 'number', step: 1, style: tfInput(), value: assetTransform.rotate[0], onChange: (e) => setTf('rotate', 0, e.target.value) }),
                              h('span', { style: { width: 34 } }, '旋转Y'), h('input', { type: 'number', step: 1, style: tfInput(), value: assetTransform.rotate[1], onChange: (e) => setTf('rotate', 1, e.target.value) }),
                              h('span', { style: { width: 34 } }, '旋转Z'), h('input', { type: 'number', step: 1, style: tfInput(), value: assetTransform.rotate[2], onChange: (e) => setTf('rotate', 2, e.target.value) })),
                            h('div', { style: { display: 'flex', gap: 6 } },
                              h('button', { style: btnPrimary, onClick: saveAssetTransform, disabled: busy }, '保存位姿'),
                              h('button', { style: btn, onClick: () => setEditingAssetId(null) }, '取消')))
                        : null,
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('select', { style: { ...input, width: 74, flexShrink: 0 }, value: assetRole, onChange: (e) => setAssetRole(e.target.value) },
                          h('option', { value: 'blank' }, '毛坯'),
                          h('option', { value: 'fixture' }, '夹具')),
                        h('input', { style: input, value: assetName, placeholder: '名称（可选）', onChange: (e) => setAssetName(e.target.value) }),
                        h('input', { style: input, value: assetPath, placeholder: 'STEP 路径（点右侧按钮选择）', onChange: (e) => setAssetPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') addAsset(); } })),
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('button', { style: btn, onClick: pickAssetFile, disabled: busy }, '📂 打开文件选择'),
                        h('button', { style: btnPrimary, onClick: addAsset, disabled: busy }, '上传并叠加显示')),
                      // 隐藏的原生文件选择框（选单个 STEP，读字节上传后回填路径）
                      h('input', { type: 'file', accept: '.step,.stp,.brep,.iges,.igs', ref: assetFileRef, style: { display: 'none' }, onChange: onAssetFileChosen }))))
              : h(Viewer3D, { data })),
          // 打赏 footer（左下角打赏 + 右下角版本号/更新提醒）
          h('div', {
            style: {
              padding: '6px 12px 8px', borderTop: '1px solid var(--dsw-alias-border-l1, #eceff3)',
              display: 'flex', alignItems: 'center', gap: 6,
            },
          },
            h('button', {
              onClick: () => setShowReward(true),
              style: {
                ...btn, fontSize: 11, padding: '3px 10px', border: 'none',
                background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
                cursor: 'pointer',
              },
            }, '如果帮助到您，可打赏支持鼓励一下'),
            h('button', {
              onClick: () => setShowReward(true),
              title: '打赏',
              style: {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, fontSize: 15, lineHeight: 1, cursor: 'pointer',
                borderRadius: '50%', border: '1px solid #f59e0b',
                background: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
                color: '#7c2d12', fontWeight: 700, padding: 0,
              },
            }, '¥'),
            h('button', {
              onClick: openLog,
              title: '查看/导出诊断日志（定位 FreeCAD 崩溃、路径等问题）',
              style: {
                ...btn, fontSize: 11, padding: '3px 10px', border: 'none',
                background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
                cursor: 'pointer',
              },
            }, '📋 日志'),
            // 支持技能：入口按钮，点击弹出技能列表弹窗（含详情与引用）
            h('button', {
              onClick: openSkills,
              title: '查看本插件支持的技能（点击查看完整方法与引用）',
              style: {
                ...btn, fontSize: 11, padding: '3px 10px', border: 'none',
                background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
                cursor: 'pointer',
              },
            }, '🧩 支持技能'),
            // 右下角：版本号（无更新时）或 更新提醒 + 手动更新按钮
            h('span', { style: { flex: 1 } }),
            versionInfo && versionInfo.updateAvailable
              ? h(React.Fragment, null,
                  h('span', {
                    title: '发现新版本 v' + (versionInfo.latest || '') + '（当前 v' + (versionInfo.current || '') + '）',
                    style: { fontSize: 11, color: '#b45309', fontWeight: 600 },
                  }, '新版本 v' + versionInfo.latest + ' 可用'),
                  h('button', {
                    onClick: doUpdate, disabled: updating,
                    style: { ...btn, fontSize: 11, padding: '2px 10px', fontWeight: 600, borderColor: 'var(--dsw-alias-state-business-primary, #2563eb)', color: 'var(--dsw-alias-state-business-primary, #2563eb)' },
                    title: '点击更新到 v' + versionInfo.latest,
                  }, updating ? '更新中…' : '更新'))
              : h('span', {
                  style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' },
                  title: '当前版本',
                }, 'v' + (versionInfo ? versionInfo.current : '…'))),
          // 打赏二维码弹窗
          showReward
            ? h('div', {
                style: {
                  position: 'fixed', inset: 0, zIndex: 3000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(15, 23, 42, 0.5)',
                },
                onClick: () => setShowReward(false),
              },
                h('div', {
                  style: {
                    background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 14, padding: '18px 20px 16px',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                    maxWidth: 'min(320px, 86vw)',
                  },
                  onClick: (e) => e.stopPropagation(),
                },
                  h('div', { style: { fontSize: 17, fontWeight: 700, color: '#1f2937', letterSpacing: '0.5px' } }, '制作不易，打赏随心'),
                  h('div', {
                    style: {
                      textAlign: 'center', fontSize: 14, lineHeight: '26px', color: '#92400e',
                      background: 'linear-gradient(135deg, #fef3c7, #fde68a)', borderRadius: 10,
                      padding: '12px 16px', fontWeight: 600, letterSpacing: '1px',
                      boxShadow: 'inset 0 0 0 1px rgba(217,119,6,0.25)',
                    },
                  },
                    '莫愁前路无知己，天下谁人不识君。', h('br', null), '起舟扬帆难不畏，越是当下最好时。'),
                  h('img', {
                    src: '/dsh-cam/qrcode', alt: '微信收款二维码',
                    title: '点击放大',
                    onClick: () => setRewardZoomed(true),
                    style: { width: 112, height: 'auto', borderRadius: 8, display: 'block', cursor: 'zoom-in' },
                  }),
                  h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } }, '👆 点击二维码可放大查看'),
                  h('div', { style: { fontSize: 15, fontWeight: 700, color: '#d97706', letterSpacing: '0.5px' } }, '微信扫码 · 支持鼓励一下'),
                  h('div', { style: { textAlign: 'center', fontSize: 13, lineHeight: '20px', color: '#4b5563', padding: '0 8px' } },
                    '如果觉得对你有帮助，打赏一下，让我知道帮助到了又一个同道中人。'),
                  h('button', { onClick: () => setShowReward(false), style: { ...btn, fontSize: 13, padding: '4px 16px' } }, '关闭')))
            : null,
          // 打赏二维码放大弹窗（点击二维码图片后放大显示）
          showReward && rewardZoomed
            ? h('div', {
                style: {
                  position: 'fixed', inset: 0, zIndex: 3200,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(15, 23, 42, 0.72)',
                },
                onClick: () => setRewardZoomed(false),
              },
                h('div', {
                  style: {
                    background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 16, padding: 20,
                    boxShadow: '0 24px 80px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
                    maxWidth: 'min(420px, 92vw)',
                  },
                  onClick: (e) => e.stopPropagation(),
                },
                  h('img', {
                    src: '/dsh-cam/qrcode', alt: '微信收款二维码（放大）',
                    style: { width: 'min(360px, 78vw)', height: 'auto', borderRadius: 10, display: 'block' },
                  }),
                  h('div', { style: { fontSize: 13, color: '#4b5563' } }, '微信扫一扫 · 支持鼓励一下'),
                  h('button', { onClick: () => setRewardZoomed(false), style: { ...btn, fontSize: 13, padding: '4px 16px' } }, '收起')))
            : null,
          // 诊断日志弹窗（查看/复制/下载插件运行日志）
          showLog
            ? h('div', {
                style: {
                  position: 'fixed', inset: 0, zIndex: 3300,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(15, 23, 42, 0.55)',
                },
                onClick: () => setShowLog(false),
              },
                h('div', {
                  style: {
                    background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 14, padding: 16,
                    boxShadow: '0 24px 80px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', gap: 10,
                    width: 'min(720px, 92vw)', maxHeight: '82vh',
                  },
                  onClick: (e) => e.stopPropagation(),
                },
                  h('div', { style: { fontSize: 15, fontWeight: 700, color: '#1f2937', display: 'flex', alignItems: 'center', gap: 8 } },
                    '诊断日志',
                    h('span', { style: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
                      logInfo ? ('文件：' + logInfo.file + ' · ' + logInfo.lines + ' 行 · ' + formatBytes(logInfo.size)) : '')),
                  h('div', { style: { fontSize: 12, color: '#6b7280', lineHeight: '18px' } },
                    '日志记录了插件启动、FreeCAD 探测/调用、模型加载、G 代码生成等每一步的耗时与错误详情。出现问题时把日志「下载」后发给我即可快速定位。'),
                  h('div', {
                    style: {
                      flex: 1, minHeight: 200, overflow: 'auto', background: '#0f172a', color: '#cbd5e1',
                      borderRadius: 8, padding: 10, fontSize: 11, lineHeight: '16px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    },
                  },
                    logLoading ? '加载日志中…'
                      : (logInfo && logInfo.text ? logInfo.text : '暂无日志（还没触发过相关操作）')),
                  h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    h('button', { onClick: clearLog, style: { ...btn, fontSize: 12, padding: '4px 12px' } }, '清空'),
                    h('button', { onClick: downloadLog, style: { ...btn, fontSize: 12, padding: '4px 12px' } }, '下载 .log'),
                    h('button', { onClick: () => setShowLog(false), style: { ...btnPrimary, fontSize: 12, padding: '4px 16px' } }, '关闭'))))
            : null,
          // 支持技能弹窗：列表 + 详情（完整方法内容 + 引用到对话框）
          showSkills
            ? h('div', {
                style: {
                  position: 'fixed', inset: 0, zIndex: 3400,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(15, 23, 42, 0.55)',
                },
                onClick: () => { setShowSkills(false); setSkillDetail(null); },
              },
                h('div', {
                  style: {
                    background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 14, padding: 16,
                    boxShadow: '0 24px 80px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', gap: 10,
                    width: 'min(760px, 92vw)', maxHeight: '82vh',
                  },
                  onClick: (e) => e.stopPropagation(),
                },
                  h('div', { style: { fontSize: 15, fontWeight: 700, color: '#1f2937', display: 'flex', alignItems: 'center', gap: 8 } },
                    '支持技能',
                    h('span', { style: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #9ca3af)' } },
                      '本插件内嵌的 CNC 加工技能，点击查看完整方法，可直接引用到对话')),
                  skillDetail
                    // 详情态：展示单个 skill 的完整方法 + 引用按钮
                    ? h(React.Fragment, null,
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                          h('button', {
                            onClick: () => setSkillDetail(null),
                            style: { ...btn, fontSize: 12, padding: '3px 10px' },
                          }, '← 返回列表'),
                          h('span', { style: { flex: 1 } }),
                          h('button', {
                            onClick: quoteSkill,
                            style: { ...btnPrimary, fontSize: 12, padding: '3px 12px' },
                            title: '把该技能的完整方法引用到对话框',
                          }, '引用到对话框')),
                        h('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--dsw-alias-label-primary, #111)' } },
                          skillDetail.title || skillDetail.name),
                        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } },
                          '调用名：' + skillDetail.name),
                        h('div', {
                          style: {
                            flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1, #fff)',
                            border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', borderRadius: 8, padding: 12,
                            fontSize: 12.5, lineHeight: '1.7', color: 'var(--dsw-alias-label-primary, #111)',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          },
                        }, skillDetail.content || skillDetail.description || '（无内容）'))
                    // 列表态：列出所有技能（可滚动，支持大量技能）
                    : h('div', {
                        style: {
                          flex: 1, minHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
                        },
                      },
                        skillsList.length > 0
                          ? skillsList.map((s) => h('div', {
                              key: s.name,
                              onClick: () => viewSkillDetail(s.name),
                              title: '点击查看完整方法',
                              style: {
                                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                                borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
                                border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', cursor: 'pointer',
                              },
                            },
                              h('span', { style: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-state-business-primary, #2563eb)', whiteSpace: 'nowrap' } }, s.title || s.name),
                              h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', whiteSpace: 'nowrap' } }, s.name),
                              h('span', { style: { flex: 1, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary, #6b7280)', lineHeight: '16px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } }, s.description),
                              h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap' } }, '查看 →')))
                          : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #9ca3af)', textAlign: 'center', padding: '20px 0' } }, '加载技能列表…')),
                  h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    h('button', { onClick: () => { setShowSkills(false); setSkillDetail(null); }, style: { ...btnPrimary, fontSize: 12, padding: '4px 16px' } }, '关闭'))))
            : null,
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
