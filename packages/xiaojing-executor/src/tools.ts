import { z } from 'zod';
import type { ToolSpec } from './types.js';

/**
 * 小镜 的工具目录。
 *
 * 注意 capability 的划分 —— 它直接决定这个工具在哪台机器上跑:
 *   cloud.*  → 服务端(持 key / token)
 *   local.*  → 用户机器(持登录态)
 *
 * 视觉三件套走 cloud.vision:服务端用 GLM 的**原生端点**调它们。
 * 已实测:Anthropic 兼容端点会静默丢图并瞎编(0/5),原生端点 5/5。
 * 所以视觉绝不能靠"把图塞进对话让模型看" —— 必须走工具。
 */
export const TOOL_CATALOG: ToolSpec[] = [
  {
    name: 'douyin_stats',
    description: '查询抖音账号的粉丝数、播放量、涨粉趋势等数据(数据源:TikHub)',
    capability: 'cloud.data',
    schema: {
      account: z.string().describe('抖音账号 ID 或主页链接'),
      days: z.number().int().min(1).max(90).optional().describe('回看天数,默认 7'),
    },
  },
  {
    name: 'read_account_profile',
    description:
      '读取当前账号档案(定位/目标客户/表达偏好/禁用表达/有效方法)。写任何对外内容前都应该先读它 —— ' +
      '档案里的「禁用表达」是合规硬红线,「表达偏好」决定文案口吻。返回里还带完整度和缺失项。',
    capability: 'cloud.data',
    schema: {
      // 刻意不收 agentId/accountId:档案归属由服务端从**已认证的身份**推出来
      // (agent → squad → douyin_account → profile)。让模型传 ID = 让它能读别人的档案。
      refresh: z
        .boolean()
        .optional()
        .describe('是否绕过快照直接重算(档案刚被改过时用),默认 false'),
    },
  },
  {
    name: 'read_image',
    description: '读图并理解内容(封面、竞品截图、数据面板截图)',
    capability: 'cloud.vision',
    schema: {
      imageUrl: z.string().describe('图片 URL 或本地路径'),
      question: z.string().describe('想从图里知道什么'),
    },
  },
  {
    name: 'generate_image',
    description: '生成封面底图。注意:只出底图,不要让它写字(中文会变成乱码)',
    capability: 'cloud.vision',
    schema: {
      prompt: z.string().describe('画面描述,不要包含要渲染的文字'),
    },
  },
  {
    name: 'compose_cover',
    description: '在底图上用代码渲染中文标题,合成最终封面',
    capability: 'cloud.vision',
    schema: {
      baseImageUrl: z.string(),
      title: z.string().describe('封面大字'),
      subtitle: z.string().optional(),
    },
  },
  {
    name: 'draft_script',
    description: '根据选题和账号人设写口播文案',
    capability: 'cloud.content',
    schema: {
      topic: z.string(),
      durationSec: z.number().int().min(15).max(600).optional(),
    },
  },
  // ── 以下是 local.browser 工具:MVP 阶段没有执行器提供该能力,
  //    registry.listRunnableTools() 会自动把它们排除在上送给模型的工具定义之外。
  //    第二期注册 PlaywrightExecutor 后,它们自动出现 —— 这里一个字都不用改。
  {
    name: 'douyin_reply_dm',
    description: '【第二期】在用户浏览器里自动回复抖音私信',
    capability: 'local.browser',
    schema: {
      conversationId: z.string(),
      text: z.string(),
    },
  },
  {
    name: 'douyin_publish',
    description: '【第二期】在用户浏览器里发布抖音视频',
    capability: 'local.browser',
    schema: {
      videoPath: z.string(),
      title: z.string(),
      topics: z.array(z.string()).optional(),
    },
  },
];
