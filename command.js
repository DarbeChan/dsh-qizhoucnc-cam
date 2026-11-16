/**
 * dsh-qizhoucnc-cam 的斜杠命令（slash command）。
 *
 * 用途：让用户在 DSH 对话框里敲 `/dsh-qizhoucnc-cam`（可带 STEP 模型附件 + 文字），
 * 把「识别刀路 / 生成 G 代码 / 渲染刀路 / 标注加工位置」的请求注入成一条模型可见的
 * 用户消息，唤醒模型 turn，让模型用本插件注册的工具（cam_generate_gcode /
 * cam_load_toolpath / cam_render_toolpath）处理。
 *
 * 命令名必须小写：宿主 dsh-commands 的 COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u。
 */

const COMMAND_NAME = 'dsh-qizhoucnc-cam';

/**
 * 手动构造一条 user-role 消息对象（等价于宿主内部 @deepseek-ai/dsh-llm 的
 * createUserMessage，但该包在 profile 里解析不到，不能直接 import）。
 * @param {Array<object>} content - content blocks（attachments + 文本块）。
 * @returns {object} 一条带随机 id、role=user 的不可变消息。
 */
function makeUserMessage(content) {
  const crypto = globalThis.crypto;
  const id = (crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `qizhoucnc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return { id, role: 'user', content, source: { kind: 'user' } };
}

/**
 * 生成注入给模型的引导文本：让模型知道这是 CNC 请求，应按需走 cam_* 工具。
 * @param {string} raw - 斜杠命令后的原始文字（可能为空）。
 * @returns {string}
 */
function buildInstruction(raw) {
  const task = raw !== '' ? raw : '识别并处理附带的 STEP 模型';
  return [
    '[QizhouCNC_CAM 请求]',
    `用户通过 /${COMMAND_NAME} 命令发起：${task}。`,
    '处理步骤：',
    '1. 若附带了 STEP/STP/BREP/IGES 模型文件，用 cam_generate_gcode 从模型生成 CNC 刀路（G 代码）；需要时可用 cam_load_toolpath 加载已有的 .nc/.cnc/.gcode 刀路文件到刀路视窗，或用 cam_render_toolpath 把刀路渲染成 3D 管状 STL 并用 cad_view 查看。',
    '2. 生成/加载后，刀路会自动出现在右侧 QizhouCNC_CAM 浮动面板的「刀路视窗」中；模型会在「模型视窗」中以三维显示，可双击面/边线标注加工位置。',
    '3. 若只是识别模型或咨询加工参数，请直接清晰说明即可，不必强行生成。',
  ].join('\n');
}

/**
 * 在宿主注册 /dsh-qizhoucnc-cam 斜杠命令。无 commands 服务时静默降级。
 * @param {object} ctx - 注入 commands 服务后的上下文（含 ctx.commands）。
 * @returns {() => void} disposer。
 */
export function mountCommand(ctx) {
  const commands = ctx && ctx.commands;
  if (commands === undefined || typeof commands.register !== 'function') {
    return () => {};
  }
  try {
    return commands.register({
      name: COMMAND_NAME,
      description: '用 dsh-qizhoucnc-cam 从 STEP 模型生成 CNC 刀路（G 代码），或加载/渲染已有刀路并查看三维刀路与模型',
      input: {
        hint: '描述要做什么，例如：从这个模型生成刀路 / 加载这个 .nc 文件查看刀路 / 把刀路渲染成 3D（可附带 STEP 或 .nc 文件）',
        attachments: true,
      },
      handler: async (invocation) => {
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : [];
        if (attachments.length === 0 && raw === '') {
          return {
            kind: 'error',
            text: '请至少附带一个 STEP/STP 模型（或 .nc/.cnc/.gcode 刀路文件），或用文字说明要做什么（例如：/dsh-qizhoucnc-cam 从 panda.step 生成刀路）。',
          };
        }
        const content = [];
        if (attachments.length > 0) {
          content.push(...attachments);
        }
        content.push({ type: 'text', text: buildInstruction(raw) });
        try {
          const message = makeUserMessage(content);
          invocation.agent.followup(message);
          return {
            kind: 'success',
            text: '已把 CNC 刀路生成 / 查看请求交给模型处理。',
          };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { kind: 'error', text: `注入失败：${text}` };
        }
      },
    });
  } catch {
    return () => {};
  }
}
