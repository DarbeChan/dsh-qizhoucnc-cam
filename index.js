import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FREECAD_BIN = '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd';
const CAM_SCRIPT = join(__dirname, 'cam_script.py');
const RENDER_SCRIPT = join(__dirname, 'toolpath_render.py');
const STATE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-toolpath.json');
const WORKSPACE_STORE = join(homedir(), '.dsh', 'storages', 'workspace.json');

// Latest parsed toolpath, exposed to the floating viewer over a same-origin route.
let latestToolpath = null;

function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// ---- all known DSH workspace paths (from the workspace store) ----
function getWorkspaceInfo() {
  const all = new Set();
  const preferred = new Set(); // default workspace + cwd: the "active" workspace
  let defaultPath = null;
  try {
    const ws = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8'));
    const table = ws?.tables?.workspaces ?? {};
    const defaultId = ws?.global?.defaultWorkspaceId;
    for (const [id, row] of Object.entries(table)) {
      if (typeof row?.path === 'string' && isAbsolute(row.path)) {
        all.add(row.path);
        if (id === defaultId) { defaultPath = row.path; preferred.add(row.path); }
      }
    }
  } catch { /* ignore */ }
  preferred.add(process.cwd());
  all.add(process.cwd());
  return { all: [...all], preferred: [...preferred], defaultPath };
}

// ---- resolve a session's workspace cwd from its projection cache ----
const SESSION_CACHE_DIR = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
function getSessionCwd(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  // session ids appear both with and without the "session-" prefix
  const candidates = [sessionId];
  if (sessionId.startsWith('session-')) candidates.push(sessionId.slice('session-'.length));
  else candidates.push('session-' + sessionId);
  for (const id of candidates) {
    try {
      const file = join(SESSION_CACHE_DIR, id + '.json');
      const d = JSON.parse(readFileSync(file, 'utf8'));
      const cwd = d?.record?.identity?.cwd ?? d?.record?.header?.cwd;
      if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd;
    } catch { /* try next */ }
  }
  return null;
}

function findPython() {
  for (const cmd of ['python3', 'python']) {
    const probe = spawnSync(cmd, ['--version'], { timeout: 5000 });
    if (probe.status === 0) return cmd;
  }
  return null;
}

// ---- persistence (survives restart) ----
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(tp) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(tp)); } catch { /* best effort */ }
}

// ---- G-code -> ordered move list ----
function parseGcode(gcode) {
  let x = 0, y = 0, z = 0;
  const moves = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0].split('(')[0].trim();
    if (!line) continue;
    let g = null, nx = x, ny = y, nz = z, i = 0, j = 0;
    for (const part of line.split(/\s+/)) {
      const u = part.toUpperCase();
      if (u.startsWith('G')) { const n = parseInt(u.slice(1), 10); if (!Number.isNaN(n)) g = n; }
      else if (u.startsWith('X')) nx = parseFloat(u.slice(1));
      else if (u.startsWith('Y')) ny = parseFloat(u.slice(1));
      else if (u.startsWith('Z')) nz = parseFloat(u.slice(1));
      else if (u.startsWith('I')) i = parseFloat(u.slice(1));
      else if (u.startsWith('J')) j = parseFloat(u.slice(1));
    }
    if (g === 0 || g === 1 || g === 2 || g === 3) {
      moves.push({ g, x, y, z, nx, ny, nz, i, j });
      x = nx; y = ny; z = nz;
    }
  }
  return moves;
}

// ---- ordered moves -> paths split by cutting vs rapid (arcs expanded) ----
function buildToolpath(gcode) {
  const moves = parseGcode(gcode);
  const paths = [];
  let cur = null;
  function push(p, cut) {
    if (!cur || cur.cut !== cut) { cur = { cut, points: [] }; paths.push(cur); }
    cur.points.push(p);
  }
  for (const m of moves) {
    if (m.g === 0 || m.g === 1) {
      push([m.nx, m.ny, m.nz], m.g === 1);
    } else {
      const cx = m.x + m.i, cy = m.y + m.j;
      const r = Math.hypot(m.x - cx, m.y - cy);
      if (r < 1e-9) { push([m.nx, m.ny, m.nz], true); continue; }
      let a0 = Math.atan2(m.y - cy, m.x - cx);
      let a1 = Math.atan2(m.ny - cy, m.nx - cx);
      let sweep;
      if (m.g === 3) { while (a1 <= a0) a1 += 2 * Math.PI; sweep = a1 - a0; }
      else { while (a1 >= a0) a1 -= 2 * Math.PI; sweep = a1 - a0; }
      const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)) + 1);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const a = a0 + sweep * t;
        push([cx + r * Math.cos(a), cy + r * Math.sin(a), m.z + (m.nz - m.z) * t], true);
      }
    }
  }
  return { paths, file: null, lines: gcode.split('\n').length, updatedAt: Date.now() };
}

// ---- load + parse a .nc file into the current toolpath ----
function loadToolpathFromFile(filePath) {
  const p = resolvePath(filePath);
  if (!existsSync(p)) throw new Error('NC file not found: ' + p);
  const gcode = readFileSync(p, 'utf8');
  const tp = buildToolpath(gcode);
  tp.file = p;
  latestToolpath = tp;
  saveState(tp);
  return tp;
}

// ---- read a single NC file's raw text (for preview/editing) ----
function readNcText(filePath) {
  const p = assertNcPath(filePath);
  return readFileSync(p, 'utf8');
}

// ---- validate that a path is a permitted NC file inside a known workspace ----
const NC_EXT = /\.(nc|cnc|gcode)$/i;
function assertNcPath(filePath) {
  const p = resolvePath(filePath);
  // 1) must be a real file (not a directory)
  if (!existsSync(p)) throw new Error('NC file not found: ' + p);
  // 2) extension must be a known NC/G-code suffix
  if (!NC_EXT.test(p)) throw new Error('Unsupported file type (allowed: .nc / .cnc / .gcode): ' + p);
  // 3) must reside inside a known DSH workspace (or the process cwd)
  const rel = (a, b) => { const r = relative(a, b); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  const dir = dirname(p);
  const { all } = getWorkspaceInfo();
  const within = all.some((ws) => rel(ws, dir));
  if (!within) throw new Error('File is outside the workspace: ' + p);
  return p;
}

// ---- save edited NC text back to the file, then re-parse the toolpath ----
function saveNcText(filePath, content) {
  const p = assertNcPath(filePath);
  if (typeof content !== 'string') throw new Error('content must be a string');
  writeFileSync(p, content, 'utf8');
  const tp = buildToolpath(content);
  tp.file = p;
  latestToolpath = tp;
  saveState(tp);
  return tp;
}

// ---- scan the workspace for files matching an extension, dedup by name ----
const STEP_EXT = /\.(step|stp)$/i;
function scanFiles(rootDir, extRe, maxDepth = 5) {
  const seen = new Map(); // name(lowercased) -> { name, path, mtime }
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!extRe.test(e.name)) continue;
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch { /* ignore */ }
      const key = e.name.toLowerCase();
      const prev = seen.get(key);
      // keep the newest copy for a given file name
      if (!prev || mtime > prev.mtime) seen.set(key, { name: e.name, path: full, mtime });
    }
  }
  walk(resolve(rootDir), 0);
  return [...seen.values()].sort((a, b) => b.mtime - a.mtime);
}

// ---- generate a G-code toolpath from a STEP/BREP/IGES model via FreeCAD CAM ----
function generateToolpathFromModel(modelPath, opts = {}) {
  const freecadBin = opts.freecadBin ?? FREECAD_BIN;
  const p = resolvePath(modelPath);
  if (!existsSync(p)) throw new Error('Model file not found: ' + p);
  // write the NC file next to the model, with the same base name (panda.step -> panda.nc)
  const base = basename(p).replace(/\.[^.]+$/, '');
  const outFile = join(dirname(p), base + '.nc');
  const env = {
    ...process.env, LANG: 'en_US.UTF-8',
    CAM_MODEL: p, CAM_OUT: outFile,
    CAM_STEPDOWN: String(opts.stepDown ?? 2), CAM_FINALDEPTH: String(opts.finalDepth ?? 6), CAM_POST: String(opts.post ?? 'grbl'),
  };
  const res = spawnSync(freecadBin, [CAM_SCRIPT], { env, encoding: 'utf8', timeout: 270_000, maxBuffer: 128 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (!existsSync(outFile)) {
    const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-12).join('\n');
    throw new Error('FreeCAD CAM failed to produce G-code.\n' + tail);
  }
  const gcode = readFileSync(outFile, 'utf8');
  const tp = buildToolpath(gcode);
  tp.file = outFile;
  latestToolpath = tp;
  saveState(tp);
  return { tp, gcode };
}

export const name = 'dsh-cam';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const freecadBin = config.freecadBin ?? FREECAD_BIN;

  // restore persisted toolpath so the viewer is not empty after a restart
  latestToolpath = loadState();

  // ---- same-origin routes: toolpath (GET/POST load), generate (POST from model) ----
  let routeDisposers = [];
  const ensureRoutes = () => {
    if (routeDisposers.length > 0) return;
    const server = ctx.get?.('webServer') ?? ctx.get?.('httpServer');
    if (!server) return;
    const send = (res, obj, code = 200) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const readBody = async (req) => {
      let payload = '';
      for await (const chunk of req) payload += chunk;
      try { return JSON.parse(payload || '{}'); } catch { return {}; }
    };

    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/toolpath',
      handler: async (req, res) => {
        if (req.method === 'POST') {
          const parsed = await readBody(req);
          try {
            const tp = loadToolpathFromFile(parsed.file);
            send(res, { ok: true, file: tp.file, lines: tp.lines, segments: tp.paths.length });
          } catch (e) {
            send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
          }
          return;
        }
        send(res, latestToolpath ?? { paths: [], file: null, lines: 0, updatedAt: null });
      },
    }));

    // read the raw text of an NC file (for preview)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/nc',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const file = url.searchParams.get('file');
          if (!file) { send(res, { ok: false, error: 'file query param required' }, 400); return; }
          const text = readNcText(file);
          send(res, { ok: true, file: resolvePath(file), content: text, lines: text.split('\n').length });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // save edited NC text back to the file (re-parses the toolpath)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/save',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        const parsed = await readBody(req);
        try {
          const tp = saveNcText(parsed.file, parsed.content);
          send(res, { ok: true, file: tp.file, lines: tp.lines, segments: tp.paths.length });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/generate',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        const parsed = await readBody(req);
        try {
          const { tp, gcode } = generateToolpathFromModel(parsed.model, {
            freecadBin, stepDown: parsed.stepDown, finalDepth: parsed.finalDepth, post: parsed.post,
          });
          send(res, { ok: true, file: tp.file, lines: gcode.split('\n').length, segments: tp.paths.length });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // list NC files found in the workspace (dedup by name)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/files',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rootsParam = url.searchParams.getAll('root');
          const sessionParam = url.searchParams.get('session');
          const { all, preferred } = getWorkspaceInfo();
          // the current session's workspace is the top priority
          const sessionCwd = getSessionCwd(sessionParam);
          if (sessionCwd) preferred.push(sessionCwd);
          // scan the requested roots (if any) plus every known workspace, dedup by name
          const roots = new Set();
          for (const r of rootsParam) if (isAbsolute(r)) { roots.add(r); preferred.push(r); }
          if (sessionCwd) roots.add(sessionCwd);
          for (const p of all) roots.add(p);
          const prefSet = new Set(preferred);
          const ncMap = new Map(), stepMap = new Map();
          for (const r of roots) {
            const pref = prefSet.has(r);
            for (const f of scanFiles(r, NC_EXT)) {
              const key = f.name.toLowerCase();
              if (!ncMap.has(key) || pref) ncMap.set(key, { ...f, preferred: pref || (ncMap.get(key)?.preferred ?? false) });
            }
            for (const f of scanFiles(r, STEP_EXT)) {
              const key = f.name.toLowerCase();
              if (!stepMap.has(key) || pref) stepMap.set(key, { ...f, preferred: pref || (stepMap.get(key)?.preferred ?? false) });
            }
          }
          // preferred first, then newest first
          const order = (a, b) => (b.preferred - a.preferred) || (b.mtime - a.mtime);
          const nc = [...ncMap.values()].sort(order);
          const steps = [...stepMap.values()].sort(order);
          send(res, { ok: true, nc, steps, roots: [...roots], sessionCwd, sessionParam });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // reveal a file in the OS file manager (macOS: open -R, else open containing dir)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/reveal',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        const parsed = await readBody(req);
        const p = resolvePath(parsed.file);
        if (!existsSync(p)) { send(res, { ok: false, error: '文件不存在: ' + p }, 400); return; }
        try {
          if (process.platform === 'darwin') {
            spawnSync('open', ['-R', p]);
          } else if (process.platform === 'win32') {
            spawnSync('explorer', ['/select,' + p]);
          } else {
            spawnSync('xdg-open', [dirname(p)]);
          }
          send(res, { ok: true, file: p });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));
  };
  ensureRoutes();
  const retry = setInterval(() => { if (routeDisposers.length === 0) ensureRoutes(); }, 100);

  const camGenerate = defineTool({
    name: 'cam_generate_gcode',
    description:
      'Generate a CNC G-code profile toolpath from a STEP/BREP/IGES model using FreeCAD CAM ' +
      '(contours the largest flat face). Returns the G-code text, writes an .nc file, and stores ' +
      'the parsed toolpath for the floating viewer.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the model (.step/.stp/.brep/.iges), absolute or relative to the workspace root.' },
      stepDown: { type: 'number', description: 'Depth per pass in mm (default 2).' },
      finalDepth: { type: 'number', description: 'Final cutting depth in mm (default 6).' },
      post: { type: 'string', description: 'FreeCAD post-processor name (default grbl).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          gcode: { type: 'string', required: true },
          file: { type: 'string', required: true },
          lines: { type: 'number', required: true },
          segments: { type: 'number', required: true, description: 'Parsed toolpath segment count (for the floating viewer).' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Generated ${value.lines} lines of G-code -> ${value.file} (${value.segments} toolpath segments). The floating viewer shows the toolpath.` },
      ],
    },
    timeoutMs: 280_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const { tp, gcode } = generateToolpathFromModel(args.path, {
        freecadBin, stepDown: args.stepDown, finalDepth: args.finalDepth, post: args.post,
      });
      return { gcode, file: tp.file, lines: gcode.split('\n').length, segments: tp.paths.length };
    },
    presentCall: (args) => ({ card: 'generic', title: `CAM toolpath ${args.path}`, kind: 'write' }),
  });

  const camLoad = defineTool({
    name: 'cam_load_toolpath',
    description:
      'Load and parse an existing G-code (.nc/.ngc/.gcode) file into the toolpath viewer. ' +
      'Use this to show a toolpath you already have, without regenerating it.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the .nc/.ngc/.gcode G-code file.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          lines: { type: 'number', required: true },
          segments: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Loaded ${value.lines} lines of G-code from ${value.file} (${value.segments} toolpath segments). The floating viewer now shows it.` },
      ],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const tp = loadToolpathFromFile(args.file);
      return { file: tp.file, lines: tp.lines, segments: tp.paths.length };
    },
    presentCall: (args) => ({ card: 'generic', title: `Load toolpath ${args.file}`, kind: 'read' }),
  });

  const camRender = defineTool({
    name: 'cam_render_toolpath',
    description:
      'Render a G-code (.nc) toolpath as a 3D tube STL, optionally merged with a model STL for context. ' +
      'Open the returned STL with cad_view to see the toolpath in 3D.',
    parameters: {
      gcode: { type: 'string', required: true, description: 'Path to the .nc G-code file.' },
      model: { type: 'string', description: 'Optional path to a model STL to merge into the same view.' },
      radius: { type: 'number', description: 'Tube radius in mm (default 2).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stl: { type: 'string', required: true },
          points: { type: 'number', required: true },
          triangles: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Toolpath rendered -> ${value.stl} (${value.points} points, ${value.triangles} triangles). Open it with cad_view.` }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const py = findPython();
      if (!py) throw new Error('No Python interpreter (python3/python) available to render the toolpath.');
      const gcodePath = resolvePath(args.gcode);
      if (!existsSync(gcodePath)) throw new Error(`G-code file not found: ${gcodePath}`);
      const tmp = mkdtempSync(join(tmpdir(), 'dsh-cam-'));
      const outStl = join(tmp, 'toolpath.stl');
      const argv = [RENDER_SCRIPT, gcodePath, outStl];
      const model = args.model ? resolvePath(args.model) : null;
      if (model) argv.push(model);
      argv.push(String(args.radius ?? 2));
      const res = spawnSync(py, argv, { encoding: 'utf8', timeout: 55_000, maxBuffer: 256 * 1024 * 1024 });
      if (res.error) throw res.error;
      if (!existsSync(outStl)) throw new Error('Toolpath render failed: ' + (res.stderr || res.stdout || '').slice(-600));
      const m = (res.stdout || '').match(/points=(\d+)\s+triangles=(\d+)/);
      return { stl: outStl, points: m ? Number(m[1]) : 0, triangles: m ? Number(m[2]) : 0 };
    },
    presentCall: (args) => ({ card: 'generic', title: `Render toolpath ${args.gcode}`, kind: 'write' }),
  });

  const disposers = [ctx.tools.register(camGenerate), ctx.tools.register(camLoad), ctx.tools.register(camRender)];
  ctx.effect(() => () => {
    clearInterval(retry);
    disposers.forEach((d) => d());
    routeDisposers.forEach((d) => d());
    routeDisposers = [];
  });
}
