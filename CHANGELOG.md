# 更新日志 (Changelog)

本文件记录 DSH-QizhouCNC_CAM 的各版本变更。

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
