import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync, copyFileSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFreecadDownload, freecadInstallStatus, portableFreecadBin } from './freecad_install.js';
import { mountCommand } from './command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认 FreeCAD 路径（macOS）。其它机器可经插件设置覆盖 freecadBin。
const FREECAD_BIN_DEFAULT = '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd';
// 常见 FreeCAD 可执行文件位置（按顺序探测）。
const FREECAD_BIN_CANDIDATES = [
  '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',
  '/usr/bin/freecadcmd',
  '/usr/local/bin/freecadcmd',
  '/opt/freecad/bin/freecadcmd',
  '/snap/bin/freecadcmd',
];
const CAM_SCRIPT = join(__dirname, 'cam_script.py');
const RENDER_SCRIPT = join(__dirname, 'toolpath_render.py');
const MODEL_SCRIPT = join(__dirname, 'model_tessellate.py');
const STATE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-toolpath.json');
const WORKSPACE_STORE = join(homedir(), '.dsh', 'storages', 'workspace.json');

// ---- 诊断日志（持久化到磁盘，便于"导出日志"定位问题） ----
// 每次调用写一行 JSON，滚动保留最近约 1MB（超过则备份为 .1 再重开）。写入失败静默忽略，绝不影响主流程。
const LOG_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam.log');
const LOG_MAX_BYTES = 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

// 写入一条结构化日志。detail 尽量是可 JSON 化的对象；字符串会原样记录。
function log(level, event, detail) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    let size = 0;
    try { size = statSync(LOG_FILE).size; } catch { /* 不存在 */ }
    if (size > LOG_MAX_BYTES) {
      try {
        const bak = LOG_FILE + '.1';
        unlinkSync(bak); // 只保留一代备份
        renameSync(LOG_FILE, bak);
      } catch { /* ignore */ }
    }
    const rec = {
      t: nowIso(),
      level,
      event,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    };
    if (detail instanceof Error) {
      rec.message = detail.message;
      rec.stack = detail.stack;
    } else if (typeof detail === 'object' && detail !== null) {
      rec.detail = detail;
    } else if (detail !== undefined && detail !== null) {
      rec.message = String(detail);
    }
    appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 日志本身失败不能影响功能 */ }
}

// 读取最近的日志（最多 maxLines 行，倒序取尾部）；返回字符串，供"导出日志"接口使用。
function readLogTail(maxLines = 2000) {
  try {
    if (!existsSync(LOG_FILE)) return '';
    const raw = readFileSync(LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch { return ''; }
}

// Latest parsed toolpath, exposed to the floating viewer over a same-origin route.
let latestToolpath = null;

// DSH-modified .nc files per session, surfaced to the client for a quick jump (feature 3).
// sessionId -> { seq, files: [{ path(absolute), display, added, deleted }] }
let changedNcFiles = {};

// ---- 版本更新检查（面板右下角：版本号 + 更新提醒 + 手动点击更新） ----
const PKG_NAME = 'dsh-qizhoucnc-cam';

// 读取本插件 package.json 里的 version（开发期是本地 dev 包，发布后是 npm 安装包，同一份清单）。
function readOwnPackage() {
  try {
    const m = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
    return { name: typeof m.name === 'string' ? m.name : null, version: typeof m.version === 'string' && m.version ? m.version : null };
  } catch { return { name: null, version: null }; }
}
function readOwnVersion() {
  return readOwnPackage().version;
}

// 解析版本号的主版本段（x.y.z 的前导数字），忽略 -beta/-rc 等后缀。
function parseVersion(v) {
  const m = String(v || '').trim().match(/^\d+(?:\.\d+)*/);
  if (!m) return null;
  return m[0].split('.').map((n) => parseInt(n, 10) || 0);
}

// 返回 >0 表示 a 比 b 新；<0 表示 a 比 b 旧；0 表示相等或无法比较。
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 查询 npm registry 最新版本（官方源 + 国内镜像回退，缓存 1 小时）。
let versionCache = { at: 0, latest: null };
async function fetchNpmLatest() {
  if (Date.now() - versionCache.at < 60 * 60 * 1000 && versionCache.latest) return versionCache.latest;
  const urls = [
    'https://registry.npmjs.org/' + PKG_NAME,
    'https://registry.npmmirror.com/' + PKG_NAME,
  ];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const latest = data && data['dist-tags'] && data['dist-tags'].latest;
      if (typeof latest === 'string' && latest) {
        versionCache = { at: Date.now(), latest };
        return latest;
      }
    } catch { /* 尝试下一个源 */ }
  }
  return versionCache.latest; // 全部失败：返回上次成功值（可能为 null）
}

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

// 解析 FreeCAD 可执行文件路径：优先插件设置 freecadBin，其次默认路径，再按候选列表探测，最后 PATH / Spotlight 命令探测。
function resolveFreecadBin(configured) {
  if (typeof configured === 'string' && configured.trim()) {
    if (existsSync(configured.trim())) return configured.trim();
    return null; // 显式配置但不存在 → 报错提示，不用探测结果混淆
  }
  if (existsSync(FREECAD_BIN_DEFAULT)) return FREECAD_BIN_DEFAULT;
  for (const cand of FREECAD_BIN_CANDIDATES) {
    if (existsSync(cand)) return cand;
  }
  // 已自动下载的便携版 FreeCAD（Windows 7z 解压 / Linux AppImage 解压）
  try {
    const portable = portableFreecadBin();
    if (portable && existsSync(portable)) return portable;
  } catch { /* ignore */ }
  // PATH 命令探测（which / where）
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const cmd of ['freecadcmd', 'freecad']) {
    try {
      const probe = spawnSync(whichCmd, [cmd], { timeout: 6000, encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout) {
        const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          .find((p) => existsSync(p));
        if (first) return first;
      }
    } catch { /* try next */ }
  }
  // macOS Spotlight 全盘索引查找
  if (process.platform === 'darwin') {
    try {
      const probe = spawnSync('mdfind', ['(kMDItemFSName == "freecadcmd") || (kMDItemFSName == "freecad")'], { timeout: 10000, encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout) {
        const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          .find((p) => existsSync(p) && /freecad(cmd)?$/i.test(p));
        if (first) return first;
      }
    } catch { /* ignore */ }
  }
  // Windows：扫描常见安装目录 Program Files 下的 FreeCAD* 版本目录
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
      try {
        for (const entry of readdirSync(root)) {
          if (!/^freecad/i.test(entry)) continue;
          const bin = join(root, entry, 'bin', 'freecadcmd.exe');
          if (existsSync(bin)) return bin;
        }
      } catch { /* ignore */ }
    }
  }
  return null;
}

// 给出 FreeCAD 缺失时的友好错误（含安装指引）。
function freecadMissingError(configured) {
  if (typeof configured === 'string' && configured.trim()) {
    return 'FreeCAD 可执行文件不存在：' + configured.trim() +
      '\n请在插件设置里把「FreeCAD 路径」改成正确的 freecadcmd 绝对路径。';
  }
  return '找不到 FreeCAD（freecadcmd）。' +
    '\n请安装 FreeCAD，或在插件设置里填写「FreeCAD 路径」指向 freecadcmd 可执行文件的绝对路径。';
}

// ---- persistence (survives restart) ----
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(tp) {
  try { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(tp)); } catch { /* best effort */ }
}

// ---- 3+2 五轴（摇篮式 AC）正向运动学：A 绕 X、C 绕 Z ----
// 程序坐标 (x,y,z) 是工件坐标系下的编程点；转台分度 (A,C) 后，刀尖在
// 机床/显示空间的位置 = Rz(C) · Rx(A) · (x,y,z)（右手系）。
// 变换顺序对应「转台 C 在下、摇篮 A 在上」的双转台 AC 构型。
// A=C=0 时退化为恒等，纯三轴程序不受影响。
const DEG = Math.PI / 180;
function applyAc(p, A, C) {
  if (!A && !C) return p;
  const [x0, y0, z0] = p;
  // 绕 X 转 A（摇篮）
  const a = A * DEG, ca = Math.cos(a), sa = Math.sin(a);
  const x1 = x0, y1 = y0 * ca - z0 * sa, z1 = y0 * sa + z0 * ca;
  // 绕 Z 转 C（转台）
  const c = C * DEG, cc = Math.cos(c), sc = Math.sin(c);
  return [x1 * cc - y1 * sc, x1 * sc + y1 * cc, z1];
}

// ---- G-code -> ordered move list ----
function parseGcode(gcode) {
  let x = 0, y = 0, z = 0, a = 0, c = 0;
  const moves = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0].split('(')[0].trim();
    if (!line) continue;
    let g = null, nx = x, ny = y, nz = z, na = a, nc = c, i = 0, j = 0;
    for (const part of line.split(/\s+/)) {
      const u = part.toUpperCase();
      if (u.startsWith('G')) { const n = parseInt(u.slice(1), 10); if (!Number.isNaN(n)) g = n; }
      else if (u.startsWith('X')) nx = parseFloat(u.slice(1));
      else if (u.startsWith('Y')) ny = parseFloat(u.slice(1));
      else if (u.startsWith('Z')) nz = parseFloat(u.slice(1));
      else if (u.startsWith('A')) na = parseFloat(u.slice(1));
      else if (u.startsWith('C')) nc = parseFloat(u.slice(1));
      else if (u.startsWith('I')) i = parseFloat(u.slice(1));
      else if (u.startsWith('J')) j = parseFloat(u.slice(1));
    }
    if (g === 0 || g === 1 || g === 2 || g === 3) {
      moves.push({ g, x, y, z, nx, ny, nz, i, j, a, c, na, nc });
      x = nx; y = ny; z = nz; a = na; c = nc;
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
    const A0 = m.a, C0 = m.c;   // 本段起点姿态（parseGcode 已累积）
    const A1 = m.na, C1 = m.nc; // 本段终点姿态

    // 姿态分度段（A/C 变化）：转台/摇篮旋转、刀具静止，工件绕转台转动。
    // 在显示上于此处断开刀路，不画旋转轨迹；下一段会以新姿态重新起笔。
    if (A0 !== A1 || C0 !== C1) { cur = null; continue; }

    // 姿态不变段：起点/终点用同一姿态变换（A0===A1 且 C0===C1）。
    const pStart = applyAc([m.x, m.y, m.z], A0, C0);
    const pEnd = applyAc([m.nx, m.ny, m.nz], A0, C0);
    if (m.g === 0 || m.g === 1) {
      push(pStart, m.g === 1);
      push(pEnd, m.g === 1);
    } else {
      const cx = m.x + m.i, cy = m.y + m.j;
      const r = Math.hypot(m.x - cx, m.y - cy);
      if (r < 1e-9) {
        push(pStart, true);
        push(pEnd, true);
        continue;
      }
      let a0 = Math.atan2(m.y - cy, m.x - cx);
      let a1 = Math.atan2(m.ny - cy, m.nx - cx);
      let sweep;
      if (m.g === 3) { while (a1 <= a0) a1 += 2 * Math.PI; sweep = a1 - a0; }
      else { while (a1 >= a0) a1 -= 2 * Math.PI; sweep = a1 - a0; }
      const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)) + 1);
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const a = a0 + sweep * t;
        // 圆弧在 XY 平面插值，z 线性；整段姿态不变，统一做 AC 变换。
        push(applyAc([cx + r * Math.cos(a), cy + r * Math.sin(a), m.z + (m.nz - m.z) * t], A0, C0), true);
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

// ---- validate that a path is a permitted NC file ----
// 不再要求文件必须位于 DSH workspace 内：用户可能把 NC 文件放在 U 盘、移动硬盘、
// 网络盘等任意位置（例如 G:\...）。只要文件真实存在、扩展名是 .nc/.cnc/.gcode 即可。
// 文件列表 UI 只展示用户显式扫描/选择到的文件，本身已是用户授权边界。
const NC_EXT = /\.(nc|cnc|gcode)$/i;
function assertNcPath(filePath) {
  const p = resolvePath(filePath);
  // 1) must be a real file (not a directory)
  if (!existsSync(p)) throw new Error('NC file not found: ' + p);
  // 2) extension must be a known NC/G-code suffix
  if (!NC_EXT.test(p)) throw new Error('Unsupported file type (allowed: .nc / .cnc / .gcode): ' + p);
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

// ---- tessellate a STEP/BREP/IGES model into renderable faces + edges via FreeCAD ----
const MODEL_EXT = /\.(step|stp|brep|iges|igs)$/i;
const FEATURE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-features.json');
const ASSETS_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-assets.json');

function assertModelPath(modelPath) {
  const p = resolvePath(modelPath);
  if (!existsSync(p)) throw new Error('Model file not found: ' + p);
  if (!MODEL_EXT.test(p)) throw new Error('Unsupported model type (allowed: .step/.stp/.brep/.iges/.igs): ' + p);
  return p;
}

// ---- stage files into a pure-ASCII temp dir before handing them to FreeCAD ----
// freecadcmd can crash with "Application unexpectedly terminated" or fail to open a
// file when the script path or model path contains non-ASCII characters (a Chinese
// username, a Chinese project folder, or Chinese file names) — most common on Windows.
// We copy the bundled .py script and the model into a fresh ASCII temp dir, run there,
// and write the .nc back to its real location with Node (which handles Unicode paths).
function hasNonAscii(s) {
  return /[^\x00-\x7F]/.test(String(s));
}

// Pick a writable temp directory whose path is pure ASCII. tmpdir() is ASCII on
// macOS/Linux and on Windows with an ASCII username, but on a Windows machine with a
// Chinese username even %TEMP% contains Chinese — so we fall back to a fixed-ASCII dir.
function asciiTmpDir(prefix) {
  const candidates = [];
  const t = tmpdir();
  if (!hasNonAscii(t)) candidates.push(t);
  if (process.platform === 'win32') {
    candidates.push('C:\\Users\\Public');
  } else {
    candidates.push('/tmp');
  }
  for (const c of candidates) {
    if (!c || hasNonAscii(c)) continue;
    try { return mkdtempSync(join(c, prefix)); } catch { /* try next */ }
  }
  // last resort: tmpdir() even if non-ASCII (still better than failing outright)
  return mkdtempSync(join(tmpdir(), prefix));
}

// Copy the bundled script + the model into one ASCII temp dir; returns the staged
// paths and a cleanup() that removes them. The model keeps its original extension so
// FreeCAD's Part.read still recognizes the format.
function stageAsciiRun(modelPath, scriptPath, scriptName) {
  const dir = asciiTmpDir('dsh-cam-');
  const ext = (basename(modelPath).match(/\.([^.]+)$/) || [])[1] || 'stp';
  const stagedScript = join(dir, scriptName);
  const stagedModel = join(dir, 'model.' + ext);
  copyFileSync(scriptPath, stagedScript);
  copyFileSync(modelPath, stagedModel);
  const cleanup = () => {
    try {
      for (const name of readdirSync(dir)) {
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
      try { rmdirSync(dir); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };
  return { stagedScript, stagedModel, cleanup };
}

function tessellateModel(modelPath, opts = {}) {
  const freecadBin = resolveFreecadBin(opts.freecadBin);
  if (!freecadBin) {
    const e = new Error(freecadMissingError(opts.freecadBin));
    log('error', 'tessellate:no-freecad', e);
    throw e;
  }
  const p = assertModelPath(modelPath);
  // Run FreeCAD from a pure-ASCII temp dir so non-ASCII script/model paths can't
  // crash freecadcmd. Always stage (cheap, ~1 file copy) to keep one code path.
  const { stagedScript, stagedModel, cleanup } = stageAsciiRun(p, MODEL_SCRIPT, 'model_tessellate.py');
  const tmp = dirname(stagedModel);
  const outFile = join(tmp, 'model.json');
  const env = {
    ...process.env, LANG: 'en_US.UTF-8',
    CAM_MODEL: stagedModel, CAM_MODEL_OUT: outFile,
    CAM_TESS_TOL: String(opts.tol ?? 0.1),
  };
  log('info', 'tessellate:start', { model: p, stagedModel, freecadBin, tol: opts.tol ?? 0.1 });
  let scene;
  try {
    const res = spawnSync(freecadBin, [stagedScript], { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024 * 1024 });
    log('info', 'tessellate:spawn-done', {
      model: p,
      status: res.status,
      signal: res.signal,
      stdoutTail: (res.stdout || '').trim().split('\n').slice(-20).join('\n'),
      stderrTail: (res.stderr || '').trim().split('\n').slice(-20).join('\n'),
    });
    if (res.error) throw res.error;
    if (!existsSync(outFile)) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-12).join('\n');
      const e = new Error('FreeCAD tessellation failed to produce model JSON.\n' + tail);
      log('error', 'tessellate:no-json', { model: p, status: res.status, signal: res.signal, stderr: (res.stderr || '').slice(-4000), stdout: (res.stdout || '').slice(-4000) });
      throw e;
    }
    try {
      scene = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch (err) {
      const e = new Error('Invalid tessellation JSON: ' + (err && err.message ? err.message : err));
      log('error', 'tessellate:bad-json', e);
      throw e;
    }
  } finally {
    cleanup();
  }
  if (!scene || scene.ok !== true) {
    const e = new Error('Tessellation failed: ' + (scene && scene.error ? scene.error : 'unknown'));
    log('error', 'tessellate:scene-not-ok', e);
    throw e;
  }
  // restore the original model path so the client still labels the model correctly
  if (typeof scene.file === 'string') scene.file = p;
  log('info', 'tessellate:done', { model: p, faces: scene.faceCount, edges: scene.edgeCount });
  return scene;
}

// ---- read / append machining-position features (named face/edge annotations) ----
function loadFeatures() {
  try { return JSON.parse(readFileSync(FEATURE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveFeatures(features) {
  try {
    mkdirSync(dirname(FEATURE_FILE), { recursive: true });
    writeFileSync(FEATURE_FILE, JSON.stringify(features, null, 2), 'utf8');
  } catch { /* ignore */ }
}
// append a named machining feature, keyed by model path; returns the updated list.
// Supports batch annotate: feature.refIds (array) creates ONE feature record that
// points at multiple faces/edges (e.g. "4 个 Φ8 孔" 一起标注)，feature.refId 为单个。
function appendFeature(modelPath, feature) {
  const p = resolvePath(modelPath);
  const all = loadFeatures();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const refIds = Array.isArray(feature.refIds)
    ? feature.refIds.map((n) => Number(n) || 0).filter((n) => n > 0)
    : [];
  const item = {
    id: feature.id ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: String(feature.name ?? '未命名'),
    kind: feature.kind === 'edge' ? 'edge' : 'face',
    refId: refIds.length ? refIds[0] : (Number(feature.refId) || 0),
    ...(refIds.length ? { refIds } : {}),
    note: String(feature.note ?? ''),
    createdAt: feature.createdAt ?? new Date().toISOString(),
  };
  list.push(item);
  all[p] = list;
  saveFeatures(all);
  return list;
}

// update an existing feature by id (rename / re-note / re-target); returns the updated list
function updateFeature(modelPath, feature) {
  const p = resolvePath(modelPath);
  const all = loadFeatures();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const idx = list.findIndex((x) => x && x.id === feature.id);
  if (idx < 0) return list;
  const cur = list[idx];
  const refIds = Array.isArray(feature.refIds)
    ? feature.refIds.map((n) => Number(n) || 0).filter((n) => n > 0)
    : (Array.isArray(cur.refIds) ? cur.refIds : null);
  const next = {
    ...cur,
    name: feature.name !== undefined ? String(feature.name) : cur.name,
    note: feature.note !== undefined ? String(feature.note) : cur.note,
    kind: feature.kind === 'edge' ? 'edge' : (feature.kind === 'face' ? 'face' : cur.kind),
    refId: feature.refId !== undefined ? Number(feature.refId) : cur.refId,
  };
  if (refIds && refIds.length > 1) {
    next.refIds = refIds;
  } else {
    delete next.refIds;
  }
  list[idx] = next;
  all[p] = list;
  saveFeatures(all);
  return list;
}

// remove a feature by id; returns the updated list
function deleteFeature(modelPath, featureId) {
  const p = resolvePath(modelPath);
  const all = loadFeatures();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const next = list.filter((x) => !x || x.id !== featureId);
  all[p] = next;
  saveFeatures(all);
  return next;
}

// ---- fixtures & blanks (毛坯/夹具): extra models overlaid on the part, with a role ----
const ASSETS_DIR = join(homedir(), '.dsh', 'storages', 'dsh-cam-assets');
function loadAssets() {
  try { return JSON.parse(readFileSync(ASSETS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveAssets(all) {
  try {
    mkdirSync(dirname(ASSETS_FILE), { recursive: true });
    writeFileSync(ASSETS_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* ignore */ }
}
function assetSceneFile(id) { return join(ASSETS_DIR, id + '.json'); }
// 夹具/毛坯相对零件的位姿：平移(mm) + 旋转(绕 X/Y/Z 度)。缺省 = 无平移无旋转。
function normalizeTransform(t) {
  if (!t || typeof t !== 'object') return { translate: [0, 0, 0], rotate: [0, 0, 0] };
  const to3 = (v, dflt) => Array.isArray(v) ? v.slice(0, 3).map((n) => Number(n) || 0) : dflt;
  return { translate: to3(t.translate, [0, 0, 0]), rotate: to3(t.rotate, [0, 0, 0]) };
}
// add or replace a fixture/blank by tessellating its STEP now; returns the updated list
function upsertAsset(modelPath, asset, opts = {}) {
  const p = resolvePath(modelPath);
  const all = loadAssets();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const item = {
    id: asset.id ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: String(asset.name || (asset.role === 'fixture' ? '夹具' : '毛坯')),
    role: asset.role === 'fixture' ? 'fixture' : 'blank',
    path: resolvePath(asset.path),
    createdAt: asset.createdAt ?? new Date().toISOString(),
    transform: normalizeTransform(asset.transform),
  };
  let scene = null;
  try { scene = tessellateModel(item.path, opts); } catch { scene = null; }
  if (scene) {
    try { mkdirSync(ASSETS_DIR, { recursive: true }); writeFileSync(assetSceneFile(item.id), JSON.stringify(scene), 'utf8'); } catch { /* ignore */ }
  }
  const idx = list.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) list[idx] = item; else list.push(item);
  all[p] = list;
  saveAssets(all);
  return list;
}
function deleteAsset(modelPath, assetId) {
  const p = resolvePath(modelPath);
  const all = loadAssets();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const next = list.filter((x) => !x || x.id !== assetId);
  all[p] = next;
  saveAssets(all);
  try { unlinkSync(assetSceneFile(assetId)); } catch { /* ignore */ }
  return next;
}
// update only the pose (translate/rotate) of one asset; scene stays cached
function updateAssetTransform(modelPath, assetId, transform) {
  const p = resolvePath(modelPath);
  const all = loadAssets();
  const list = Array.isArray(all[p]) ? all[p] : [];
  const idx = list.findIndex((x) => x && x.id === assetId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], transform: normalizeTransform(transform) };
    all[p] = list;
    saveAssets(all);
  }
  return list;
}
// read an asset's cached tessellation scene (or null if not yet tessellated)
function assetSceneOf(asset) {
  try { return JSON.parse(readFileSync(assetSceneFile(asset.id), 'utf8')) || null; } catch { return null; }
}

// ---- generate a G-code toolpath from a STEP/BREP/IGES model via FreeCAD CAM ----
function generateToolpathFromModel(modelPath, opts = {}) {
  const freecadBin = resolveFreecadBin(opts.freecadBin);
  if (!freecadBin) {
    const e = new Error(freecadMissingError(opts.freecadBin));
    log('error', 'cam:no-freecad', e);
    throw e;
  }
  const p = resolvePath(modelPath);
  if (!existsSync(p)) {
    const e = new Error('Model file not found: ' + p);
    log('error', 'cam:model-missing', e);
    throw e;
  }
  // write the NC file next to the model, with the same base name (panda.step -> panda.nc)
  const base = basename(p).replace(/\.[^.]+$/, '');
  const outFile = join(dirname(p), base + '.nc');
  // Stage into a pure-ASCII temp dir (script + model + intermediate NC) so non-ASCII
  // paths can't crash freecadcmd. The final .nc is written back to outFile by Node.
  const { stagedScript, stagedModel, cleanup } = stageAsciiRun(p, CAM_SCRIPT, 'cam_script.py');
  const stagedOut = join(dirname(stagedModel), 'out.nc');
  const env = {
    ...process.env, LANG: 'en_US.UTF-8',
    CAM_MODEL: stagedModel, CAM_OUT: stagedOut,
    CAM_STEPDOWN: String(opts.stepDown ?? 2), CAM_FINALDEPTH: String(opts.finalDepth ?? 6), CAM_POST: String(opts.post ?? 'grbl'),
  };
  log('info', 'cam:start', { model: p, outFile, freecadBin, stepDown: opts.stepDown, finalDepth: opts.finalDepth, post: opts.post });
  let gcode;
  try {
    const res = spawnSync(freecadBin, [stagedScript], { env, encoding: 'utf8', timeout: 270_000, maxBuffer: 128 * 1024 * 1024 });
    log('info', 'cam:spawn-done', {
      model: p,
      status: res.status,
      signal: res.signal,
      stdoutTail: (res.stdout || '').trim().split('\n').slice(-20).join('\n'),
      stderrTail: (res.stderr || '').trim().split('\n').slice(-20).join('\n'),
    });
    if (res.error) throw res.error;
    if (!existsSync(stagedOut)) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-12).join('\n');
      const e = new Error('FreeCAD CAM failed to produce G-code.\n' + tail);
      log('error', 'cam:no-gcode', { model: p, status: res.status, signal: res.signal, stderr: (res.stderr || '').slice(-4000), stdout: (res.stdout || '').slice(-4000) });
      throw e;
    }
    gcode = readFileSync(stagedOut, 'utf8');
    writeFileSync(outFile, gcode, 'utf8');
  } finally {
    cleanup();
  }
  const tp = buildToolpath(gcode);
  tp.file = outFile;
  latestToolpath = tp;
  saveState(tp);
  log('info', 'cam:done', { model: p, outFile, lines: gcode.split('\n').length, segments: tp.paths.length });
  return { tp, gcode };
}

export const name = 'dsh-cam';
export const inject = ['tools', 'workspaceChanges'];

// 插件设置：可覆盖 FreeCAD 可执行文件路径（其它机器 FreeCAD 不在默认位置时用）。
export const Config = z.object({
  freecadBin: z.string().description('FreeCAD freecadcmd 可执行文件的绝对路径；留空则自动探测。').default(''),
}).loose();

export function apply(ctx, config = {}) {
  // 原始配置值；真正解析（含探测与友好报错）在 tessellateModel / generateToolpathFromModel 内按需进行。
  const freecadBin = config.freecadBin;

  log('info', 'plugin:start', {
    version: readOwnVersion(),
    freecadConfigured: typeof freecadBin === 'string' && freecadBin.trim() ? freecadBin.trim() : null,
    tmpdir: tmpdir(),
    dshHome: join(homedir(), '.dsh'),
  });

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

    // WeChat reward QR code (static PNG served from the plugin package)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/qrcode',
      handler: async (req, res) => {
        try {
          const png = readFileSync(join(__dirname, 'qrcode.png'));
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'content-length': png.length });
          res.end(png);
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 404);
        }
      },
    }));

    // NC files this session's model has modified, for a quick jump (feature 3).
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/changed',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const sessionParam = url.searchParams.get('session');
          const seq = url.searchParams.get('seq');
          if (seq !== null) delete changedNcFiles[sessionParam || ''];
          send(res, { ok: true, session: sessionParam, files: (sessionParam && changedNcFiles[sessionParam]) || [], seq: seq ?? null });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // tessellate a STEP/BREP/IGES model into faces+edges for the 3D model viewport
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/model',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        const parsed = await readBody(req);
        try {
          const scene = tessellateModel(parsed.model, { freecadBin, tol: parsed.tol });
          send(res, scene);
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // read the machining-position features recorded for a model
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/feature',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const model = url.searchParams.get('model');
          if (req.method === 'POST') {
            const parsed = await readBody(req);
            const model = parsed.model ?? url.searchParams.get('model');
            if (parsed.op === 'update') {
              const list = updateFeature(model, parsed);
              send(res, { ok: true, model: resolvePath(model), features: list });
              return;
            }
            if (parsed.op === 'delete') {
              const list = deleteFeature(model, parsed.id);
              send(res, { ok: true, model: resolvePath(model), features: list });
              return;
            }
            const list = appendFeature(model, parsed);
            send(res, { ok: true, model: resolvePath(model), features: list });
            return;
          }
          if (!model) { send(res, { ok: false, error: 'model query param required' }, 400); return; }
          const all = loadFeatures();
          const p = resolvePath(model);
          send(res, { ok: true, model: p, features: Array.isArray(all[p]) ? all[p] : [] });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // list / add / remove fixture & blank (毛坯/夹具) models overlaid on the part
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/assets',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const model = url.searchParams.get('model');
          if (req.method === 'POST') {
            const parsed = await readBody(req);
            const key = parsed.model ?? url.searchParams.get('model');
            if (!key) { send(res, { ok: false, error: 'model query param required' }, 400); return; }
            if (parsed.op === 'delete') {
              const list = deleteAsset(key, parsed.id);
              send(res, { ok: true, model: resolvePath(key), assets: list });
              return;
            }
            if (parsed.op === 'transform') {
              const list = updateAssetTransform(key, parsed.id, parsed.transform);
              send(res, { ok: true, model: resolvePath(key), assets: list });
              return;
            }
            const list = upsertAsset(key, parsed, { freecadBin });
            send(res, { ok: true, model: resolvePath(key), assets: list });
            return;
          }
          if (!model) { send(res, { ok: false, error: 'model query param required' }, 400); return; }
          const all = loadAssets();
          const p = resolvePath(model);
          send(res, { ok: true, model: p, assets: Array.isArray(all[p]) ? all[p] : [] });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // read one asset's tessellated scene (for overlay rendering)
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/asset-scene',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const id = url.searchParams.get('id');
          const model = url.searchParams.get('model');
          if (!id || !model) { send(res, { ok: false, error: 'id and model query params required' }, 400); return; }
          const all = loadAssets();
          const p = resolvePath(model);
          const list = Array.isArray(all[p]) ? all[p] : [];
          const asset = list.find((x) => x && x.id === id);
          if (!asset) { send(res, { ok: false, error: 'asset not found' }, 404); return; }
          const scene = assetSceneOf(asset);
          if (!scene) { send(res, { ok: false, error: 'asset scene not tessellated' }, 404); return; }
          send(res, { ok: true, asset: { id: asset.id, name: asset.name, role: asset.role, path: asset.path, transform: asset.transform }, scene });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // 上传单个 STEP 文件（浏览器 <input type=file> 拿不到绝对路径，改为把文件字节 POST 上来，落到项目 uploads/ 目录并返回绝对路径）
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/upload',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        try {
          const parsed = await readBody(req);
          const name = String(parsed.name || '').replace(/[\\/]/g, '_');
          const data = parsed.data; // base64 string
          if (!name || !data) { send(res, { ok: false, error: 'name and data(base64) required' }, 400); return; }
          const buf = Buffer.from(data, 'base64');
          const dir = join(ASSETS_DIR, 'uploads');
          mkdirSync(dir, { recursive: true });
          const dest = join(dir, Date.now().toString(36) + '-' + name);
          writeFileSync(dest, buf);
          send(res, { ok: true, path: dest, name });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // FreeCAD 自动下载状态（供客户端展示进度 / 触发下载）
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/freecad',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST') {
            const st = ensureFreecadDownload();
            send(res, { ok: true, found: !!resolveFreecadBin(freecadBin), ...st });
            return;
          }
          send(res, { ok: true, found: !!resolveFreecadBin(freecadBin), ...freecadInstallStatus() });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // 诊断日志：查看/导出插件运行日志（用于定位 FreeCAD 崩溃、路径、下载等问题）。
    // GET 返回最近日志文本；POST 清空日志文件（可选）。
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/log',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const maxLines = parseInt(url.searchParams.get('lines') || '2000', 10) || 2000;
          if (req.method === 'POST') {
            // 清空日志（保留 .1 备份不被删除，只清主文件）
            try { writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* ignore */ }
            send(res, { ok: true, cleared: true });
            return;
          }
          const text = readLogTail(maxLines);
          let size = 0;
          try { size = statSync(LOG_FILE).size; } catch { /* ignore */ }
          send(res, {
            ok: true,
            file: LOG_FILE,
            size,
            lines: text ? text.split('\n').length : 0,
            text,
          });
        } catch (e) {
          send(res, { ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      },
    }));

    // 版本更新检查（GET：本插件版本 + npm 最新版本 + 是否有更新）。
    // 实际的「点击更新」由客户端直接调用 dshmarket 的公共更新 API 完成，
    // 因为该 API 需要浏览器会话 cookie（同源保护），宿主进程拿不到。
    // 只有以 npm 包名 dsh-qizhoucnc-cam 安装时，市场更新 API 才能定位并更新它；
    // 本地 file:/link: 开发包（@local/dsh-cam）返回 updatable:false，客户端只显示版本号。
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/version',
      handler: async (req, res) => {
        try {
          const pkg = readOwnPackage();
          const current = pkg.version;
          const pkgName = pkg.name;
          // 只有以 npm 包名安装的副本才可经市场更新 API 更新。
          const updatable = pkgName === PKG_NAME;
          let latest = null;
          if (updatable) {
            try { latest = await fetchNpmLatest(); } catch { /* 网络失败则 latest 为 null */ }
          }
          const updateAvailable = updatable && latest && current ? compareVersions(latest, current) > 0 : false;
          send(res, { ok: true, pkgName: pkgName || '', current: current || '1.0.0', latest, updateAvailable, updatable });
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

  // 斜杠命令 /dsh-qizhoucnc-cam：可带 STEP 模型附件，把「生成/查看刀路」请求注入给模型。
  // commands 是可选服务，缺失时 mountCommand 静默降级为 no-op。
  let disposeCommand = () => {};
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (host) => {
        disposeCommand = mountCommand(host);
        return disposeCommand;
      });
    } else if (ctx.commands && typeof ctx.commands.register === 'function') {
      disposeCommand = mountCommand(ctx);
    }
  } catch { /* 斜杠命令不可用则跳过，不影响工具本身 */ }

  ctx.effect(() => () => {
    clearInterval(retry);
    disposers.forEach((d) => d());
    routeDisposers.forEach((d) => d());
    routeDisposers = [];
    disposeCommand();
    unlistenChanges();
  });

  // Listen for DSH model edits to NC files and surface them for a quick jump (feature 3).
  // The workspace-changes service serves summaries only on request (summary(sessionId, seq)),
  // so we consume the 'session/event' event (workspace/changes) to learn the seq, then read
  // the summary and filter to .nc files. We tolerate races (summary may resolve a tick later)
  // by reading on both the event and a short settle timer.
  let unlistenChanges = () => {};
  try {
    if (typeof ctx.on === 'function' && ctx.get?.('workspaceChanges')) {
      unlistenChanges = ctx.on('session/event', async (session, event) => {
        try {
          if (!event || event.type !== 'workspace/changes') return;
          const sessionId = session?.id;
          if (!sessionId) return;
          const wc = ctx.get('workspaceChanges');
          if (!wc || typeof wc.summary !== 'function') return;
          const seq = event.seq;
          const read = () => {
            const s = wc.summary(sessionId, seq);
            if (!s || !Array.isArray(s.files)) return;
            const nc = s.files
              .filter((f) => f && typeof f.path === 'string' && NC_EXT.test(f.path))
              .map((f) => ({
                path: isAbsolute(f.path) ? f.path : join(s.cwd || '', f.path),
                display: f.display ?? f.path,
                added: f.added ?? 0,
                deleted: f.deleted ?? 0,
              }));
            if (nc.length) changedNcFiles[sessionId] = { seq, files: nc };
          };
          read();
          // summary may not be committed yet when the event fires; retry a few times
          for (let i = 0; i < 5; i++) setTimeout(read, 200 * (i + 1));
        } catch { /* ignore */ }
      });
    }
  } catch { /* ignore */ }
}
