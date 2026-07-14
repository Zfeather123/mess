/**
 * 网关配置。key 只在服务端,**永不下发客户端**。
 *
 * 客户端(小镜桌面端)手里只有 sessionToken —— 它把 sessionToken 当作
 * ANTHROPIC_API_KEY 发给我们,我们校验完换成真正的 GLM key 再转发出去。
 * 用户不用注册 GLM、不用填 key。
 */
export interface GatewayConfig {
  port: number;
  /**
   * 算力账本的库。**必填,不给默认值,起不来也不许静默回落内存账本** ——
   * 内存账本一重启余额就归零、冻结就消失,那不是「降级运行」,那是无声地丢钱。
   */
  databaseUrl: string;
  /** GLM 的 Anthropic 兼容端点 —— 给 Agent SDK 的模型请求透传用。 */
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  /**
   * GLM 原生 OpenAI 端点 —— **视觉工具专用,不可省**。
   *
   * 实测(JIN-51,同一张中文合同截图):
   *   原生端点 + glm-4.6v  → 6/6 全读对
   *   Anthropic 兼容端点   → 0/6,模型直接说「我读不了图片」
   * 图片走消息流是死路,必须走这个端点。
   */
  glmNativeBaseUrl: string;
  glmApiKey: string;
  models: {
    /** 读图。实测满分。 */
    vision: string;
    /** 出底图。⚠️ 只让它出图,别让它写字(中文必乱码)。 */
    image: string;
  };
  /** 封面标题渲染用的中文字体。缺了会渲染成豆腐块。 */
  coverFontPath: string;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[gateway] 缺少环境变量 ${name}`);
  return v;
}

/**
 * 变量名跟随仓库 `.env.example` 里已有的约定(`GLM_OPENAI_*` / `JIN_*`),
 * 不另起一套 —— 两套命名并存迟早会让人配错一半。
 */
export function loadConfig(): GatewayConfig {
  return {
    port: Number(process.env.JIN_GATEWAY_PORT ?? 8787),
    databaseUrl: required('DATABASE_URL'),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/anthropic',
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    glmNativeBaseUrl: process.env.GLM_OPENAI_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4',
    glmApiKey: required('GLM_OPENAI_API_KEY'),
    models: {
      vision: process.env.GLM_VISION_MODEL?.trim() || 'glm-4.6v',
      image: process.env.GLM_IMAGE_MODEL?.trim() || 'cogview-4',
    },
    coverFontPath: required('JIN_COVER_FONT_PATH'),
  };
}
