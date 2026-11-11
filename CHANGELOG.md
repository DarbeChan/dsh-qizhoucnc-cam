# 更新日志 (Changelog)

本文件记录 DSH-QizhouCNC_CAM 的各版本变更。

## [1.1.0] - 2026-11-12

### 新增 (Added)

- **点击插件外区域自动折叠**：面板展开时，点击面板外的任意区域会自动把插件收起回右侧侧边栏；点击面板内部（含编辑器、拖拽把手）不会误触发。
- **AI 修改 G-code 后自动识别并刷新**：编辑器会轮询当前打开的 NC 文件，检测到磁盘内容变化（如 AI 修复刀路后写回）时自动刷新编辑器内容，无需手动刷新。
- **DSH 会话中修改的 NC 文件快捷跳转**：监听 DSH 会话里模型对 `.nc` 文件的改动（`workspace/changes`），在插件内弹出「AI 刚修改了 N 个 NC 文件」横幅，列出文件名与增删行数，点击即可直接在插件内打开该文件。

### 变更 (Changed)

- host 侧 `inject` 增加 `workspaceChanges` 服务（用于读取会话文件改动摘要），并新增 `GET /dsh-cam/changed` 路由。

---

## [1.0.0] - 2026-11-11

### 新增 (Added)

- **侧边栏宽度可拖拽调节**：面板左边缘新增拖拽手柄（`cursor: col-resize`），按住左右拖动即可调节面板宽度（360～1400px），松手后用 `localStorage`（key `dsh-cam-panel-width`）持久化，下次打开自动恢复。（commit `d8d49ce`）

### 安全 (Security)

- **收紧 NC 文件读写范围**：采纳 awesome-dsh-plugin 维护者 fkysly 的安全建议，`/dsh-cam/nc`（读）与 `/dsh-cam/save`（写）现在只接受 `.nc` / `.cnc` / `.gcode` 扩展名，且路径必须落在工作区内（用 `relative()` 防 `../` 越界），否则拒绝并报错。（commit `5cc223d`）

### 维护 (Chore)

- 声明 `@deepseek-ai/dsh-tools` 为 `peerDependencies`（`>=0.2.2-rc.1 <0.3.0`），满足 awesome-dsh-plugin 收录规范。（commit `507bbb9`）
- 补充问题反馈渠道：GitHub Issues + 邮箱 651712988@qq.com。（commit `35f884b`）

---

## 说明

- 首发版本（commit `5def2e1`），包含 NC 刀路识别与三维显示、六视图/等轴视角、大界面 NC 编辑器、代码引用到对话框、工作区文件扫描、STEP 模型生成刀路、打开文件所在位置等功能。
- 本插件由成都起舟机械科技有限公司制作，仅供研究学习使用。
