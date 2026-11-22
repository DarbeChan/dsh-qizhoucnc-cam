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
const DIFF_SCRIPT = join(__dirname, 'stock_diff.py');
const STATE_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-toolpath.json');
const WORKSPACE_STORE = join(homedir(), '.dsh', 'storages', 'workspace.json');
// 用户导入的技能目录：每个技能一个子目录，内含 SKILL.md（frontmatter 含 name/title/description）。
const IMPORTED_SKILLS_DIR = join(homedir(), '.dsh', 'storages', 'dsh-cam-skills');
// 技能调用名规范：小写字母/数字/连字符（与 skill 服务的 SKILL_NAME 约束一致）。
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---- 工具调用规范（随每个技能一起下发给 agent）----
// 每个 skill 本质是「如何调用已制作好的 cam_* 工具」的方法说明；这里统一附上工具签名与
// 参数规范，保证导入的（用户自写）技能也能正确调用插件工具。
const TOOL_REFERENCE = [
  '## 工具调用规范（qizhouCNC_CAM）',
  '',
  '本插件已制作好以下工具，技能内容请严格按签名调用（参数名/类型一致）：',
  '',
  '### cam_generate_gcode',
  '- 用途：用 FreeCAD CAM 从 STEP/BREP/IGES 模型生成 G 代码刀路（外轮廓，取最大平面）。',
  '- 参数：`path`(必填，模型路径) · `stepDown`(每刀深度 mm，默认 2) · `finalDepth`(最终深度 mm，默认 6) · `post`(后处理器名，默认 grbl)。',
  '- 返回：`gcode`(文本) · `file`(.nc 路径) · `lines` · `segments`。',
  '',
  '### cam_load_toolpath',
  '- 用途：把已有 .nc/.ngc/.gcode 文件解析进刀路视窗（不重新生成）。',
  '- 参数：`file`(必填，G 代码路径)。',
  '',
  '### cam_render_toolpath',
  '- 用途：把 .nc 刀路渲染成 3D 管状 STL，可合入模型 STL 一起用 cad_view 查看。',
  '- 参数：`gcode`(必填，.nc 路径) · `model`(可选，模型 STL) · `radius`(管径 mm，默认 2)。',
  '',
  '### cam_inspect_model',
  '- 用途：读取 STEP/BREP/IGES 模型的面/边几何摘要（类型/半径/轴线/面积/中心/shapeKey），供匹配「Φ8 孔=半径 4 圆柱面」。',
  '- 参数：`path`(必填，模型路径)。',
  '- 返回：`faces`(每个含 id/type/radius/axis/area/center/shapeKey) · `edges`。',
  '',
  '### cam_annotate_feature',
  '- 用途：把「刀具/坐标系/加工内容」写到一个或多个面/边的标注 note 上（模型视窗高亮显示）。',
  '- 参数：`path`(必填) · `name`(必填，如「Φ8 定位孔」) · `kind`(必填，`face`|`edge`) · `refId`(单个 id) 或 `refIds`(批量 id 数组) · `tool`(如「T3=Φ6.9 定心钻」) · `coordinate`(如「G54」) · `note`(补充) · `op`(`update` 需配 `id`)。',
  '',
  '### cam_get_model_pose',
  '- 用途：读取成品模型当前工件坐标位置参数（用户在视窗「应用到位」保存的位移/旋转）。',
  '- 参数：`path`(必填)。返回 `transform`(translate/rotate) 或 null。',
  '',
  '### cam_stock_difference',
  '- 用途：布尔差「毛坯 − 成品」计算待去除材料体积/包围盒/面边数。',
  '- 参数：`stock`(必填，毛坯路径) · `part`(必填，成品路径)。',
  '',
  '### 通用规范',
  '- 路径用绝对路径，或相对当前工作区根；先用 `cam_inspect_model` 拿真实 id，不要编造。',
  '- 直径换半径：`半径 = 直径 ÷ 2`；螺纹按底孔直径算半径。',
  '- 同尺寸多特征用 `refIds` 一次批量标注，避免重复调用。',
].join('\n');

// 把工具规范附加到技能正文末尾（注册与详情展示都走这里，保证 agent 拿到工具签名）。
function withToolRef(body) {
  const b = String(body || '').trim();
  return b ? b + '\n\n' + TOOL_REFERENCE : TOOL_REFERENCE;
}

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

// ---- G-code -> ordered move list ----
// 注意：FANUC 3+2 定轴程序的 X/Y/Z 已经是「旋转到位后的最终加工坐标」，
// Z 就是主轴进给方向（钻孔沿 Z 负、铣面在 XY 平面），不需要再按 A/C 姿态做
// 正向运动学旋转。此前错误地做了 Rz(C)·Rx(A) 变换，把钻孔方向转成了水平，
// 导致刀路显示错误。这里只累积 A/C（用于显示姿态信息），坐标原样使用。
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
    // 姿态分度段（A/C 变化）：转台旋转、刀具静止，在显示上断开，不画旋转轨迹。
    if (m.a !== m.na || m.c !== m.nc) { cur = null; continue; }
    // 坐标原样使用（已是最终加工坐标），不再做 AC 旋转变换。
    if (m.g === 0 || m.g === 1) {
      push([m.x, m.y, m.z], m.g === 1);
      push([m.nx, m.ny, m.nz], m.g === 1);
    } else {
      const cx = m.x + m.i, cy = m.y + m.j;
      const r = Math.hypot(m.x - cx, m.y - cy);
      if (r < 1e-9) {
        push([m.x, m.y, m.z], true);
        push([m.nx, m.ny, m.nz], true);
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
// 主模型（成品）的位置参数：modelPath -> { translate:[x,y,z], rotate:[rx,ry,rz] }
const MAIN_TRANSFORM_FILE = join(homedir(), '.dsh', 'storages', 'dsh-cam-main-transform.json');

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

// ---- 毛坯 - 成品 布尔差：计算需要被加工去除的材料 ----
// 用 FreeCAD 做布尔差，网格化结果供模型视窗叠加显示（绿色半透明），并返回体积/包围盒。
function stockDifference(stockPath, partPath, opts = {}) {
  const freecadBin = resolveFreecadBin(opts.freecadBin);
  if (!freecadBin) {
    const e = new Error(freecadMissingError(opts.freecadBin));
    log('error', 'diff:no-freecad', e);
    throw e;
  }
  const sp = resolvePath(stockPath);
  const pp = resolvePath(partPath);
  if (!existsSync(sp)) throw new Error('Stock model not found: ' + sp);
  if (!existsSync(pp)) throw new Error('Part model not found: ' + pp);
  // Stage both models + script into a pure-ASCII temp dir (avoid non-ASCII path crash)
  const dir = asciiTmpDir('dsh-cam-diff-');
  const extS = (basename(sp).match(/\.([^.]+)$/) || [])[1] || 'stp';
  const extP = (basename(pp).match(/\.([^.]+)$/) || [])[1] || 'stp';
  const stagedScript = join(dir, 'stock_diff.py');
  const stagedStock = join(dir, 'stock.' + extS);
  const stagedPart = join(dir, 'part.' + extP);
  const outFile = join(dir, 'diff.json');
  copyFileSync(DIFF_SCRIPT, stagedScript);
  copyFileSync(sp, stagedStock);
  copyFileSync(pp, stagedPart);
  const cleanup = () => {
    try {
      for (const name of readdirSync(dir)) { try { unlinkSync(join(dir, name)); } catch { /* ignore */ } }
      try { rmdirSync(dir); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };
  const env = {
    ...process.env, LANG: 'en_US.UTF-8',
    CAM_STOCK: stagedStock, CAM_PART: stagedPart, CAM_DIFF_OUT: outFile,
  };
  log('info', 'diff:start', { stock: sp, part: pp, freecadBin });
  let result;
  try {
    const res = spawnSync(freecadBin, [stagedScript], { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024 * 1024 });
    log('info', 'diff:spawn-done', {
      stock: sp, part: pp,
      status: res.status, signal: res.signal,
      stdoutTail: (res.stdout || '').trim().split('\n').slice(-10).join('\n'),
      stderrTail: (res.stderr || '').trim().split('\n').slice(-10).join('\n'),
    });
    if (res.error) throw res.error;
    if (!existsSync(outFile)) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-12).join('\n');
      const e = new Error('FreeCAD boolean difference failed to produce JSON.\n' + tail);
      log('error', 'diff:no-json', { stock: sp, part: pp, stderr: (res.stderr || '').slice(-4000), stdout: (res.stdout || '').slice(-4000) });
      throw e;
    }
    result = JSON.parse(readFileSync(outFile, 'utf8'));
  } finally {
    cleanup();
  }
  if (!result || result.ok !== true) {
    const e = new Error('Boolean difference failed: ' + (result && result.error ? result.error : 'unknown'));
    log('error', 'diff:not-ok', e);
    throw e;
  }
  result.stock = sp;
  result.part = pp;
  log('info', 'diff:done', { stock: sp, part: pp, volume: result.volume, faces: result.faceCount, empty: result.empty });
  return result;
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

// ---- 主模型（成品）位置参数持久化：modelPath -> { translate, rotate } ----
function loadMainTransforms() {
  try { return JSON.parse(readFileSync(MAIN_TRANSFORM_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveMainTransforms(all) {
  try {
    mkdirSync(dirname(MAIN_TRANSFORM_FILE), { recursive: true });
    writeFileSync(MAIN_TRANSFORM_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* ignore */ }
}
// 保存/读取某个模型的位置参数；transform 为 null 表示清除（复位）
function setMainTransform(modelPath, transform) {
  const p = resolvePath(modelPath);
  const all = loadMainTransforms();
  if (transform === null || transform === undefined) delete all[p];
  else all[p] = normalizeTransform(transform);
  saveMainTransforms(all);
  return all[p] ?? null;
}
function getMainTransform(modelPath) {
  const p = resolvePath(modelPath);
  const all = loadMainTransforms();
  return all[p] ?? null;
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

  // ---- 插件内嵌 skill 清单（唯一数据源）----
  // 既用于 ctx.skills.register 注册，也用于 /dsh-cam/skills 路由展示「支持哪些技能」。
  const SKILLS = [
    {
      name: 'cnc-process-card',
      title: 'CNC 工艺卡',
      description:
        '根据毛坯、成品模型、装夹方式与刀具清单，自动生成 CNC 加工的 MD 工艺卡（坐标系、刀具清单、工艺顺序、注意事项）。' +
        '当用户上传毛坯/成品模型、给出装夹与刀具，要求出工艺卡、排工艺、写加工步骤时使用。',
    },
    {
      name: 'cnc-auto-annotate',
      title: 'CNC 自动标注',
      description:
        '根据 CNC 工艺卡，自动在 qizhouCNC_CAM 中标注成品零件的加工特征——每个面/边用什么刀具、什么坐标系。' +
        '当用户提供工艺卡（或上一轮已生成）和成品模型，要求自动标注、标注刀具与坐标系时使用。',
    },
    {
      name: 'cnc-stock-diff',
      title: '毛坯差异计算',
      description:
        '计算毛坯与成品模型的差异（布尔差：毛坯−成品），得出需要被加工去除的材料体积与区域，并读取成品模型工件坐标与加工坐标位置。' +
        '当用户提供毛坯和成品模型、要求分析加工余量、判断需要去除哪些材料、或读取模型位置参数时使用。',
    },
  ];

  // 读取某个 skill 的 SKILL.md 正文（剥 frontmatter）。注册与路由共用。
  const readSkillBody = (name) => {
    const SKILL_MD = join(__dirname, 'skills', name, 'SKILL.md');
    let content = '';
    try { content = readFileSync(SKILL_MD, 'utf8'); } catch { content = ''; }
    if (!content) return '';
    return content.replace(/^\s*---[\s\S]*?---\s*/, '').trim();
  };

  // ---- 导入技能（用户上传 SKILL.md 提炼的成功方法）----
  // 持久化到 ~/.dsh/storages/dsh-cam-skills/<name>/SKILL.md，并在 /dsh-cam/skills 列表里合并展示，
  // 同时注册进 skill 服务（与内嵌技能同机制）。frontmatter 需含 name/title/description。
  // 返回 { skill } 或抛错（名称非法/缺失 frontmatter 等）。
  function parseSkillMarkdown(md) {
    const text = String(md || '').trim();
    if (!text) throw new Error('SKILL.md 内容为空');
    const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
    if (!m) throw new Error('缺少 YAML frontmatter（--- 开头，含 name/description）');
    const fm = m[1];
    const get = (key) => {
      const re = new RegExp('^' + key + ':\\s*(.+)$', 'm');
      const mm = re.exec(fm);
      return mm ? mm[1].trim() : '';
    };
    const name = get('name');
    const description = get('description');
    const title = get('title');
    if (!name) throw new Error('frontmatter 缺少 name 字段');
    if (!SKILL_NAME_RE.test(name)) throw new Error('技能名称(name)需为小写字母/数字/连字符，如 cnc-my-method');
    if (!description) throw new Error('frontmatter 缺少 description 字段');
    const body = text.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    if (!body) throw new Error('SKILL.md 正文为空（frontmatter 之后需有方法内容）');
    return {
      name,
      title: title || name,
      description,
      content: body,
    };
  }

  function listImportedSkillNames() {
    try {
      if (!existsSync(IMPORTED_SKILLS_DIR)) return [];
      return readdirSync(IMPORTED_SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SKILL_NAME_RE.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch { return []; }
  }

  function readImportedSkill(name) {
    if (!SKILL_NAME_RE.test(name)) return null;
    const md = join(IMPORTED_SKILLS_DIR, name, 'SKILL.md');
    try {
      const raw = readFileSync(md, 'utf8');
      const skill = parseSkillMarkdown(raw);
      // 目录名是唯一事实来源，防止 frontmatter name 与目录名不一致
      skill.name = name;
      return skill;
    } catch { return null; }
  }

  function listImportedSkills() {
    return listImportedSkillNames().map((n) => readImportedSkill(n)).filter(Boolean);
  }

  function writeImportedSkill(skill) {
    const dir = join(IMPORTED_SKILLS_DIR, skill.name);
    try {
      mkdirSync(dir, { recursive: true });
      const md = '---\nname: ' + skill.name + '\ntitle: ' + (skill.title || skill.name) + '\ndescription: ' + skill.description + '\n---\n\n' + skill.content + '\n';
      writeFileSync(join(dir, 'SKILL.md'), md, 'utf8');
    } catch (e) {
      throw new Error('保存技能失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  function deleteImportedSkill(name) {
    if (!SKILL_NAME_RE.test(name)) return false;
    const dir = join(IMPORTED_SKILLS_DIR, name);
    try {
      if (!existsSync(dir)) return false;
      const files = readdirSync(dir);
      for (const f of files) { try { unlinkSync(join(dir, f)); } catch { /* ignore */ } }
      try { rmdirSync(dir); } catch { /* ignore */ }
      return true;
    } catch { return false; }
  }

  // 内嵌技能 + 导入技能 合并（内嵌优先；导入的加 imported:true 标记）。
  function allSkills() {
    const imported = listImportedSkills().map((s) => ({ ...s, imported: true }));
    // 内嵌优先排前面，导入的按名称排后面
    const seen = new Set(SKILLS.map((s) => s.name));
    return [...SKILLS, ...imported.filter((s) => !seen.has(s.name))];
  }

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

    // 毛坯 - 成品 布尔差：返回待去除材料的网格化场景（供模型视窗叠加显示）
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/stock-diff',
      handler: async (req, res) => {
        if (req.method !== 'POST') { send(res, { ok: false, error: 'POST only' }, 405); return; }
        const parsed = await readBody(req);
        try {
          const result = stockDifference(parsed.stock, parsed.part, { freecadBin });
          send(res, {
            ok: true, stock: result.stock, part: result.part,
            volume: result.volume, empty: !!result.empty, bounds: result.bounds,
            faces: result.faces, edges: result.edges,
            faceCount: result.faceCount, edgeCount: result.edgeCount,
          });
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

    // 主模型（成品）位置参数：GET 读、POST 存（transform=null 清除）
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/main-transform',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const model = url.searchParams.get('model');
          if (req.method === 'POST') {
            const parsed = await readBody(req);
            const key = parsed.model ?? url.searchParams.get('model');
            if (!key) { send(res, { ok: false, error: 'model query param required' }, 400); return; }
            const tf = setMainTransform(key, parsed.transform ?? null);
            send(res, { ok: true, model: resolvePath(key), transform: tf });
            return;
          }
          if (!model) { send(res, { ok: false, error: 'model query param required' }, 400); return; }
          send(res, { ok: true, model: resolvePath(model), transform: getMainTransform(model) });
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

    // 插件支持的 skill 列表（供主界面「支持技能」弹窗展示 + 详情查看 + 导入）
    routeDisposers.push(server.register({
      kind: 'prefix',
      path: '/dsh-cam/skills',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const name = url.searchParams.get('name');
          if (req.method === 'POST') {
            const parsed = await readBody(req);
            // 导入：body { md: string }（SKILL.md 原文）——提炼的成功方法
            if (parsed.op === 'import') {
              try {
                const skill = parseSkillMarkdown(parsed.md);
                writeImportedSkill(skill);
                send(res, { ok: true, skill, message: `技能已导入：${skill.title}（调用名 ${skill.name}）` });
              } catch (e) {
                send(res, { ok: false, error: String(e && e.message ? e.message : String(e)) }, 400);
              }
              return;
            }
            // 删除：body { name: string }（仅导入的技能可删）
            if (parsed.op === 'delete') {
              const n = String(parsed.name || '');
              if (!n || !SKILL_NAME_RE.test(n)) { send(res, { ok: false, error: '技能名称非法' }, 400); return; }
              if (SKILLS.some((s) => s.name === n)) { send(res, { ok: false, error: '内嵌技能不可删除' }, 400); return; }
              const ok = deleteImportedSkill(n);
              send(res, { ok, deleted: ok });
              return;
            }
            send(res, { ok: false, error: 'unknown op' }, 400);
            return;
          }
          // 单个 skill 详情：先查内嵌，再查导入（正文附工具调用规范）
          if (name) {
            const builtin = SKILLS.find((s) => s.name === name);
            if (builtin) { send(res, { ok: true, skill: { ...builtin, content: withToolRef(readSkillBody(name)) } }); return; }
            const imported = readImportedSkill(name);
            if (imported) { send(res, { ok: true, skill: { ...imported, content: withToolRef(imported.content) } }); return; }
            send(res, { ok: false, error: 'skill not found: ' + name }, 404);
            return;
          }
          send(res, { ok: true, skills: allSkills() });
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

  // ---- 模型几何检查：供 agent 按工艺卡自动匹配「哪类特征对应哪个面/边」 ----
  // 返回每个面/边的可读几何摘要（类型/半径/轴线/面积/中心），不含顶点与三角面，
  // 轻量、够 agent 做「Φ8 孔 → 半径 4 的圆柱面」这类匹配，又不灌爆上下文。
  const camInspectModel = defineTool({
    name: 'cam_inspect_model',
    description:
      'Inspect the tessellated faces and edges of a STEP/BREP/IGES model. Returns a compact ' +
      'per-face/per-edge summary (surface type, radius, axis, area, center, shapeKey) so the ' +
      'agent can match a process-card operation to concrete faces — e.g. a Φ8 drilled hole is ' +
      'a Cylinder face with radius 4. Use before cam_annotate_feature to decide which face/edge ids to annotate.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the model (.step/.stp/.brep/.iges), absolute or relative to the workspace root.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          faces: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Face summaries: { id, kind, type, radius, axis, area, center, shapeKey }.' },
          edges: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Edge summaries: { id, type, radius, shapeKey }.' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Inspected ${value.file}: ${value.faces.length} faces, ${value.edges.length} edges.` },
      ],
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const scene = tessellateModel(args.path, { freecadBin });
      const summarizeFace = (f) => {
        const g = f.geometry || {};
        const out = { id: f.id, type: g.type || 'unknown' };
        if (g.radius !== undefined) out.radius = g.radius;
        if (g.majorRadius !== undefined) out.majorRadius = g.majorRadius;
        if (g.axis) out.axis = g.axis;
        if (f.area !== undefined) out.area = f.area;
        if (f.center) out.center = f.center;
        if (f.shapeKey) out.shapeKey = f.shapeKey;
        return out;
      };
      const summarizeEdge = (e) => {
        const out = { id: e.id };
        if (e.shapeKey) {
          const m = /^circle:r([0-9.]+)$/.exec(e.shapeKey);
          if (m) out.type = 'circle', out.radius = parseFloat(m[1]);
          else if (/^line:/.test(e.shapeKey)) out.type = 'line';
          else out.type = 'edge';
        }
        return out;
      };
      return {
        file: scene.file || resolvePath(args.path),
        faces: (scene.faces || []).map(summarizeFace),
        edges: (scene.edges || []).map(summarizeEdge),
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Inspect model ${args.path}`, kind: 'read' }),
  });

  // ---- 按工艺卡写标注：agent 把「刀具 + 坐标系 + 加工内容」写入面/边的 note ----
  // 复用现有 feature 存储（appendFeature / updateFeature）。note 字段承载
  // 「T#刀具 · G5#坐标系 · 加工内容」，UI 左侧标注列表直接可见。
  const camAnnotateFeature = defineTool({
    name: 'cam_annotate_feature',
    description:
      'Write a machining-position annotation (which tool, which work coordinate, what operation) ' +
      'onto one or more faces/edges of a model. The tool/coordinate/operation text goes into the ' +
      'annotation note, which the qizhouCNC_CAM model viewport shows next to the highlighted face. ' +
      'Use cam_inspect_model first to find the right face/edge ids. refIds writes one annotation ' +
      'covering several ids (e.g. four equal Φ8 holes); refId writes a single one. op=update rewrites an existing annotation by id.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the model (.step/.stp/.brep/.iges).' },
      name: { type: 'string', required: true, description: 'Short annotation name, e.g. "Φ8 定位孔" or "M6 螺纹".' },
      kind: { type: 'string', required: true, description: '"face" or "edge".' },
      refId: { type: 'number', description: 'Face/edge id (from cam_inspect_model) for a single annotation.' },
      refIds: { type: 'array', items: { type: 'number' }, description: 'Face/edge ids for one batch annotation covering several features.' },
      tool: { type: 'string', description: 'Tool spec, e.g. "T3=Φ6.9 定心钻".' },
      coordinate: { type: 'string', description: 'Work coordinate, e.g. "G54" or "G55".' },
      note: { type: 'string', description: 'Extra note, e.g. "钻底孔 深10".' },
      op: { type: 'string', description: '"update" to rewrite an existing annotation, otherwise append.' },
      id: { type: 'string', description: 'Existing annotation id (required with op=update).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          features: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Annotation written: ${value.features.length} feature(s) on the model now.` },
      ],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const p = resolvePath(args.path);
      const refIds = Array.isArray(args.refIds)
        ? args.refIds.map((n) => Number(n) || 0).filter((n) => n > 0)
        : [];
      // note 组装：tool · coordinate · note（缺省字段不拼空段）
      const parts = [];
      if (args.tool) parts.push(String(args.tool).trim());
      if (args.coordinate) parts.push(String(args.coordinate).trim());
      if (args.note) parts.push(String(args.note).trim());
      const combinedNote = parts.join(' · ');
      const feature = {
        name: String(args.name ?? '未命名'),
        kind: args.kind === 'edge' ? 'edge' : 'face',
        refId: refIds.length ? refIds[0] : (Number(args.refId) || 0),
        ...(refIds.length > 1 ? { refIds } : {}),
        note: combinedNote,
      };
      if (args.op === 'update' && args.id) {
        const list = updateFeature(p, { ...feature, id: args.id });
        return { model: p, features: list };
      }
      const list = appendFeature(p, feature);
      return { model: p, features: list };
    },
    presentCall: (args) => ({ card: 'generic', title: `Annotate ${args.path}`, kind: 'write' }),
  });

  // ---- 读取成品模型工件坐标（位置参数：位移/旋转，含用户在模型视窗修改后保存的值）----
  const camGetModelPose = defineTool({
    name: 'cam_get_model_pose',
    description:
      'Read the current work-coordinate pose of a part model (the translate/rotate the user set in the ' +
      'model viewport, persisted on "apply"). Returns { translate:[x,y,z] mm, rotate:[rx,ry,rz] deg } or null ' +
      'when the model has no saved pose. Use to understand the part\'s position/orientation in the machine frame.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the part model (.step/.stp/.brep/.iges).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          transform: { type: 'object', additionalProperties: true, required: true, description: '{ translate:[x,y,z], rotate:[rx,ry,rz] } or null.' },
        },
      },
      render: (_args, value) => {
        const t = value.transform;
        const text = t
          ? `Model pose: translate (${t.translate.map((v) => +v.toFixed(3)).join(', ')}) mm, rotate (${t.rotate.map((v) => +v.toFixed(2)).join(', ')}) deg.`
          : 'Model has no saved pose (identity).';
        return [{ type: 'text', text }];
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const p = resolvePath(args.path);
      return { model: p, transform: getMainTransform(p) };
    },
    presentCall: (args) => ({ card: 'generic', title: `Model pose ${args.path}`, kind: 'read' }),
  });

  // ---- 毛坯 - 成品 布尔差：计算需要被加工去除的材料 ----
  const camStockDifference = defineTool({
    name: 'cam_stock_difference',
    description:
      'Compute the material to remove by boolean-differencing the blank/stock model and the finished ' +
      'part model (stock − part). Returns the removed-material volume (mm^3), bounding box, and ' +
      'face/edge counts. Use to quickly understand how much material must be machined away from the blank; ' +
      'the full tessellated scene (for viewport overlay) is available via the /dsh-cam/stock-diff route.',
    parameters: {
      stock: { type: 'string', required: true, description: 'Path to the blank/stock model (.step/.stp/.brep/.iges).' },
      part: { type: 'string', required: true, description: 'Path to the finished part model (.step/.stp/.brep/.iges).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          stock: { type: 'string', required: true },
          part: { type: 'string', required: true },
          volume: { type: 'number', required: true, description: 'Material to remove, mm^3.' },
          empty: { type: 'boolean', required: true, description: 'True when nothing to remove.' },
          bounds: { type: 'object', additionalProperties: true, required: true },
          faceCount: { type: 'number', required: true },
          edgeCount: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        const text = value.empty
          ? 'Nothing to remove: the stock already matches the part.'
          : `Material to remove: ${(+value.volume).toLocaleString()} mm³ (${value.faceCount} faces, ${value.edgeCount} edges). Bounding box ${value.bounds.min.join(',')} ~ ${value.bounds.max.join(',')}.`;
        return [{ type: 'text', text }];
      },
    },
    timeoutMs: 200_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const r = stockDifference(args.stock, args.part, { freecadBin });
      return {
        stock: r.stock, part: r.part, volume: r.volume, empty: !!r.empty,
        bounds: r.bounds, faceCount: r.faceCount, edgeCount: r.edgeCount,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `Stock difference ${args.stock}`, kind: 'read' }),
  });

  const disposers = [
    ctx.tools.register(camGenerate),
    ctx.tools.register(camLoad),
    ctx.tools.register(camRender),
    ctx.tools.register(camInspectModel),
    ctx.tools.register(camAnnotateFeature),
    ctx.tools.register(camGetModelPose),
    ctx.tools.register(camStockDifference),
  ];

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

  // ---- 内嵌 CNC 工艺 skill + 用户导入技能 ----
  // 通过 ctx.skills.register 注册运行时 skill：随插件发布，任何装本插件的人都能用
  // skill 工具调用。可选服务：无 skills 服务时静默跳过，不影响其余功能。
  // SKILLS 常量定义在 apply 开头（内嵌技能唯一数据源），导入技能读自 IMPORTED_SKILLS_DIR。
  let disposeSkill = () => {};
  try {
    // 单个 skill 的注册：读 SKILL.md 正文，用 name/description 注册。导入技能直接给 content。
    const registerOne = (host, skill, content) => {
      if (!host || typeof host.skills?.register !== 'function') return () => {};
      const body = content != null ? content : readSkillBody(skill.name);
      if (!body) return () => {};
      try {
        return host.skills.register({ name: skill.name, description: skill.description, content: withToolRef(body) });      } catch (e) {
        log('warn', 'skill:register-failed', { name: skill.name, error: e && e.message ? e.message : String(e) });
        return () => {};
      }
    };
    const registerSkills = (host) => {
      const disposers = [];
      for (const s of SKILLS) disposers.push(registerOne(host, s));
      for (const s of listImportedSkills()) disposers.push(registerOne(host, s, s.content));
      return () => { disposers.forEach((d) => { try { d(); } catch { /* ignore */ } }); };
    };
    if (typeof ctx.inject === 'function') {
      ctx.inject(['skills'], (host) => {
        disposeSkill = registerSkills(host);
        return disposeSkill;
      });
    } else if (ctx.skills && typeof ctx.skills.register === 'function') {
      disposeSkill = registerSkills(ctx);
    }
  } catch { /* skills 服务不可用则跳过 */ }

  ctx.effect(() => () => {
    clearInterval(retry);
    disposers.forEach((d) => d());
    routeDisposers.forEach((d) => d());
    routeDisposers = [];
    disposeCommand();
    disposeSkill();
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
