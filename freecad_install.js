// 自动下载 FreeCAD（便携版）到插件数据目录，并定位 freecadcmd 可执行文件。
// 覆盖：Linux AppImage（解压 --appimage-extract）、Windows 7z（需本机 7z 解压）。
// macOS 暂不支持自动下载（返回明确提示），当前机器默认路径 /Applications/FreeCAD.app 已可被 resolveFreecadBin 探测。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const FREEACAD_DIR = join(homedir(), '.dsh', 'storages', 'dsh-cam-freecad');
const STATE_FILE = join(FREEACAD_DIR, 'install-state.json');
const RELEASES_API = 'https://api.github.com/repos/FreeCAD/FreeCAD/releases/latest';

// 各平台可选用的便携资产（Windows 用 7z，Linux 用 AppImage；macOS 暂无便携方案，标记 unsupported）。
const PLATFORM_ASSETS = {
  'linux-x64':   { label: 'Linux x86_64 AppImage',   pattern: /FreeCAD_.*-Linux-x86_64.*\.AppImage$/i,   kind: 'appimage' },
  'linux-arm64': { label: 'Linux aarch64 AppImage',  pattern: /FreeCAD_.*-Linux-aarch64.*\.AppImage$/i,  kind: 'appimage' },
  'win32-x64':   { label: 'Windows x86_64 7z',       pattern: /FreeCAD_.*-Windows-x86_64.*\.7z$/i,       kind: '7z' },
  'win32-arm64': { label: 'Windows arm64 7z',        pattern: /FreeCAD_.*-Windows-arm64.*\.7z$/i,        kind: '7z' },
  'darwin-arm64':{ label: 'macOS arm64 dmg',         pattern: /FreeCAD_.*-macOS-arm64.*\.dmg$/i,        kind: 'dmg' },
  'darwin-x64':  { label: 'macOS x86_64 dmg',        pattern: /FreeCAD_.*-macOS-x86_64.*\.dmg$/i,       kind: 'dmg' },
};

function platformKey() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return `${process.platform}-${arch}`;
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { mkdirSync(FREEACAD_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch { /* ignore */ }
}

// 模块级内存态（当前进程内权威），磁盘态用于重启后恢复「已下载/已解压」结果。
let memoryState = loadState();
let downloadJob = null; // 正在运行的后台 curl 子进程

function setState(patch) {
  memoryState = { ...memoryState, ...patch };
  saveState(memoryState);
  return memoryState;
}

// 用 curl 拉取 GitHub 最新 release 的资产清单（缓存 10 分钟）。
let releaseCache = { at: 0, assets: [] };
function fetchReleaseAssets() {
  if (Date.now() - releaseCache.at < 10 * 60 * 1000 && releaseCache.assets.length) return releaseCache.assets;
  const res = spawnSync('curl', ['-s', '--max-time', '25', '-H', 'Accept: application/vnd.github+json', RELEASES_API], { encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0 || !res.stdout) return [];
  try {
    const data = JSON.parse(res.stdout);
    const assets = (data.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
    releaseCache = { at: Date.now(), assets };
    return assets;
  } catch { return []; }
}

// 根据当前平台挑选要下载的资产。
export function freecadAsset() {
  const key = platformKey();
  const spec = PLATFORM_ASSETS[key];
  if (!spec) return { supported: false, reason: `暂不支持平台 ${key} 的自动下载。` };
  if (spec.kind === 'dmg') return { supported: false, reason: 'macOS 暂不支持自动下载，请手动安装 FreeCAD 或填写 freecadBin 路径。', spec };
  const assets = fetchReleaseAssets();
  const hit = assets.find((a) => spec.pattern.test(a.name));
  if (!hit) return { supported: false, reason: '未能在 FreeCAD 官方 release 中找到匹配当前平台的资产。', spec };
  return { supported: true, spec, asset: hit };
}

// 扫描便携目录，返回已解压好的 freecadcmd 绝对路径，或 null。
export function portableFreecadBin() {
  if (!existsSync(FREEACAD_DIR)) return null;
  // Windows 实际二进制名是 FreeCADCmd.exe（大写 C），Linux 是 freecadcmd；用大小写不敏感匹配。
  const want = process.platform === 'win32' ? /^freecadcmd\.exe$/i : /^freecadcmd$/;
  const stack = [FREEACAD_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (want.test(name)) return p;
    }
  }
  return null;
}

// 解压已下载资产，返回 freecadcmd 绝对路径或抛错。
function extractAsset(dest, kind) {
  if (kind === 'appimage') {
    chmodSync(dest, 0o755);
    // AppImage 需 --appimage-extract 解出 squashfs-root/usr/bin/freecadcmd（无需 FUSE）。
    const res = spawnSync(dest, ['--appimage-extract'], { cwd: FREEACAD_DIR, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error('AppImage 解压失败：' + (res.stderr || res.stdout || '').slice(-600));
    const bin = join(FREEACAD_DIR, 'squashfs-root', 'usr', 'bin', 'freecadcmd');
    if (!existsSync(bin)) throw new Error('AppImage 解压后未找到 freecadcmd：' + bin);
    return bin;
  }
  if (kind === '7z') {
    // Windows 7z 需本机 7z/7za/7zr；找不到则报错提示安装 7-Zip 或用官方安装包。
    let sevenZip = null;
    for (const cmd of ['7z', '7za', '7zr']) {
      const probe = spawnSync(cmd, [], { timeout: 5000 });
      if (probe.error === undefined || probe.error === null) { sevenZip = cmd; break; }
    }
    if (!sevenZip) {
      throw new Error('解压 FreeCAD 7z 需要本机安装 7-Zip（未找到 7z 命令）。请先安装 7-Zip，或改用官方 installer.exe 安装。');
    }
    const res = spawnSync(sevenZip, ['x', '-y', '-o' + FREEACAD_DIR, dest], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0) throw new Error('7z 解压失败：' + (res.stderr || res.stdout || '').slice(-600));
    const bin = portableFreecadBin();
    if (!bin) throw new Error('7z 解压后未找到 freecadcmd.exe');
    return bin;
  }
  throw new Error('不支持的资产类型：' + kind);
}

// 下载 FreeCAD 资产（重试 + 国内镜像回退）。成功后返回最终下载路径。
function downloadAsset(asset, dest) {
  // 从 GitHub 直连下载（国内可能被重置）。失败则回退国内加速镜像 ghproxy。
  const urls = [asset.url, 'https://mirror.ghproxy.com/' + asset.url, 'https://ghproxy.net/' + asset.url];
  // 本地文件是否已完整下载（>= 远端体积）。这是 416 报错的关键判据：
  // curl -C - 对「已下满」的文件续传时，服务器返回 HTTP 416（Range 不可满足），curl 以 22 退出。
  const completeOnDisk = () => {
    if (!(asset.size > 0)) return false;
    try { return statSync(dest).size >= asset.size; } catch { return false; }
  };
  return new Promise((resolve, reject) => {
    const tryUrl = (idx) => {
      if (idx >= urls.length) { reject(new Error('所有下载源均失败')); return; }
      // 已完整（例如上次下到 100% 但进程中断后再次触发）：直接视为下载完成，不再发请求。
      if (completeOnDisk()) { resolve(dest); return; }
      const url = urls[idx];
      // -C - 断点续传：本地有半截文件则从断点继续，本地为空则从头下载。
      const child = spawn('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '15', '--max-time', '0', '-C', '-', '-o', dest, '--progress-bar', url], {
        cwd: FREEACAD_DIR, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errBuf = '';
      child.stderr.on('data', (d) => { errBuf += String(d); });
      child.on('exit', (code) => {
        if (code === 0) { resolve(dest); return; }
        // 下载到 100% 后 curl 重试续传收到 416 以 22 退出：文件其实已完整，按成功处理继续解压。
        if (completeOnDisk()) { resolve(dest); return; }
        // 记录失败并回退下一个源。**不要删除 dest**：保留半截文件供 curl -C - 断点续传。
        if (idx + 1 < urls.length) {
          tryUrl(idx + 1);
        } else {
          reject(new Error('下载失败：' + (errBuf.slice(-300) || ('exit ' + code))));
        }
      });
    };
    tryUrl(0);
  });
}

// 后台下载（幂等：已在下载/已就绪则直接返回状态）。返回当前状态快照。
export function ensureFreecadDownload() {
  if (memoryState.bin && existsSync(memoryState.bin)) {
    return { ...memoryState, phase: 'done' };
  }
  if (downloadJob) {
    return memoryState; // 正在下载/回退链中
  }
  const { supported, spec, asset, reason } = freecadAsset();
  if (!supported) {
    return setState({ phase: 'error', error: reason });
  }
  mkdirSync(FREEACAD_DIR, { recursive: true });
  const dest = join(FREEACAD_DIR, asset.name);
  // 保留已下载的半截文件，供 curl -C - 断点续传（意外中断后点「继续下载」）。
  let existing = 0;
  try { existing = statSync(dest).size; } catch { /* 无半截文件 */ }
  setState({ phase: 'downloading', asset: asset.name, url: asset.url, dest, total: asset.size, downloaded: existing, error: null, bin: null });
  const running = { done: false };
  downloadJob = running;
  downloadAsset(asset, dest).then(() => {
    try {
      setState({ phase: 'extracting' });
      const bin = extractAsset(dest, spec.kind);
      setState({ phase: 'done', bin, downloaded: asset.size });
    } catch (e) {
      setState({ phase: 'error', error: String(e && e.message ? e.message : e) });
    } finally {
      running.done = true;
      downloadJob = null;
    }
  }).catch((e) => {
    setState({ phase: 'error', error: String(e && e.message ? e.message : e) });
    running.done = true;
    downloadJob = null;
  });
  return memoryState;
}

// 下载进度：轮询 dest 文件大小，更新内存/磁盘态。
export function freecadInstallStatus() {
  if (memoryState.phase === 'downloading' && memoryState.dest) {
    // 若后台下载进程已不在了（中断/重启），把状态修正为 interrupted，让前端显示「继续下载」按钮。
    if (!downloadJob) {
      let partial = 0;
      try { partial = statSync(memoryState.dest).size; } catch { /* file not created */ }
      if (partial > 0) {
        memoryState = { ...memoryState, phase: 'interrupted', downloaded: partial };
        saveState(memoryState);
      } else {
        memoryState = { ...memoryState, phase: 'idle', downloaded: 0 };
        saveState(memoryState);
      }
    } else {
      try {
        const st = statSync(memoryState.dest);
        if (st.size !== memoryState.downloaded) setState({ downloaded: st.size });
      } catch { /* file not created yet */ }
    }
  }
  return { ...memoryState, platform: platformKey(), supported: !!PLATFORM_ASSETS[platformKey()] && PLATFORM_ASSETS[platformKey()].kind !== 'dmg' };
}
