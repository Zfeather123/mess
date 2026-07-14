import { createHash } from "node:crypto";

/**
 * 知识库的 embedding provider(JIN-55)。
 *
 * ⚠️ 走 GLM 的**原生 OpenAI 端点** `GLM_OPENAI_BASE_URL`(/api/paas/v4),
 * 不是 Anthropic 兼容端点 —— 兼容端点会静默丢内容并瞎编(实测),而且它根本没有 /embeddings。
 * 这条纪律和视觉工具是同一条,别再踩。
 *
 * 两个 provider:
 *   - glm:           生产。真调 GLM,花钱。
 *   - deterministic: CI / 本地 / 没 key 时。纯函数,不联网,同样的文本永远同样的向量。
 *
 * 为什么必须有 deterministic 这一档:
 *   1) CI 里没有 GLM key,也不该有 —— 仓库是公开的;
 *   2) 单测不能依赖外部 API 的可用性和余额(写这行字的时候 GLM 账号正好欠费 429);
 *   3) 「按员工的引用开关」这条验收是**检索层**的语义,它的正确性不该依赖某个模型的权重。
 * 用假向量恰恰能把开关这件事测死:向量一样,唯一的变量就是开关。
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dims: number;
  /** 返回 L2 归一化后的向量 —— 归一化在写入侧做掉,检索侧的余弦就退化成点积。 */
  embed(texts: string[]): Promise<number[][]>;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** L2 归一化。零向量原样返回(全零文本,余弦无意义,检索期自然拿 0 分)。 */
export function normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0 || !Number.isFinite(magnitude)) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

/**
 * 点积。两边都是单位向量时 == 余弦相似度。
 * 维度不一致直接判 0 分,不抛 —— 换过 embedding 模型后库里会同时存在两种维度的历史向量,
 * 让一条旧向量把整次检索炸掉是最糟的选择。这些旧向量会在重索引时被覆盖。
 */
export function dotProduct(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return Number.isFinite(sum) ? sum : 0;
}

// ---------------------------------------------------------------------------
// deterministic provider —— hashed n-gram 词袋
// ---------------------------------------------------------------------------

const DETERMINISTIC_DIMS = 256;

/**
 * 中文没有空格分词,所以按**字符 n-gram**(1~2 gram)切,再 hash 到固定维度。
 * 这不是什么好的语义模型 —— 它只保证:字面重合越多,余弦越高。
 * 对「开关生不生效」这条验收来说,这个性质就够了,而且它是确定性的。
 */
function deterministicEmbed(text: string, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0);
  const normalizedText = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalizedText.length === 0) return vector;

  const grams: string[] = [];
  for (let i = 0; i < normalizedText.length; i += 1) {
    grams.push(normalizedText[i]!);
    if (i + 1 < normalizedText.length) grams.push(normalizedText.slice(i, i + 2));
  }

  for (const gram of grams) {
    // sha256 的前 4 字节当 hash;取模落桶。符号位再取一位,避免所有分量同号。
    const digest = createHash("sha256").update(gram, "utf8").digest();
    const bucket = digest.readUInt32BE(0) % dims;
    const sign = (digest[4]! & 1) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalize(vector);
}

export function deterministicEmbeddingProvider(dims = DETERMINISTIC_DIMS): EmbeddingProvider {
  return {
    name: "deterministic",
    model: `deterministic-hash-${dims}`,
    dims,
    async embed(texts: string[]) {
      return texts.map((text) => deterministicEmbed(text, dims));
    },
  };
}

// ---------------------------------------------------------------------------
// GLM provider
// ---------------------------------------------------------------------------

/** GLM embedding-3 的维度。GLM 支持 dimensions 入参,这里显式钉死,避免落库维度漂移。 */
const GLM_EMBEDDING_DIMS = 1024;
const GLM_EMBEDDING_MODEL = "embedding-3";
/** GLM 单次 embeddings 请求的输入条数上限(保守取值)。 */
const GLM_BATCH_SIZE = 32;
const GLM_TIMEOUT_MS = 30_000;

export class EmbeddingProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export function glmEmbeddingProvider(options: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  dims?: number;
}): EmbeddingProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const model = options.model ?? GLM_EMBEDDING_MODEL;
  const dims = options.dims ?? GLM_EMBEDDING_DIMS;

  async function embedBatch(batch: string[]): Promise<number[][]> {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({ model, input: batch, dimensions: dims }),
      signal: AbortSignal.timeout(GLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 不吞错误码:1113 = 余额不足,429 = 限流,401 = key 不对。
      // 上层据此把 index_state.status 置成 failed 并把原因写进 error 列。
      throw new EmbeddingProviderError(
        `GLM embeddings failed: ${response.status} ${body.slice(0, 300)}`,
        response.status,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const rows = payload.data ?? [];
    if (rows.length !== batch.length) {
      throw new EmbeddingProviderError(
        `GLM embeddings returned ${rows.length} vectors for ${batch.length} inputs`,
      );
    }
    // GLM 不保证按序返回,认 index。
    const ordered = new Array<number[]>(batch.length);
    rows.forEach((row, position) => {
      const target = typeof row.index === "number" ? row.index : position;
      const embedding = row.embedding ?? [];
      if (embedding.length === 0) {
        throw new EmbeddingProviderError("GLM embeddings returned an empty vector");
      }
      ordered[target] = normalize(embedding);
    });
    if (ordered.some((vector) => !vector)) {
      throw new EmbeddingProviderError("GLM embeddings returned a sparse index set");
    }
    return ordered;
  }

  return {
    name: "glm",
    model,
    dims,
    async embed(texts: string[]) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += GLM_BATCH_SIZE) {
        out.push(...(await embedBatch(texts.slice(i, i + GLM_BATCH_SIZE))));
      }
      return out;
    },
  };
}

/**
 * 有 key 就用 GLM,没 key 就退到 deterministic。
 *
 * **绝不硬编码 key** —— 仓库是公开的,推送保护会拦。
 * 退化时不抛异常:没配 key 的开发者也该能把知识库跑起来看效果,
 * 只是检索质量是「字面重合」而不是语义 —— 这一点由 provider.name 暴露给上层,
 * 上层会把它记进 index_state.embedding_model,不会假装自己用的是真模型。
 */
export function resolveEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider {
  const baseUrl = env.GLM_OPENAI_BASE_URL?.trim();
  const apiKey = env.GLM_OPENAI_API_KEY?.trim();
  if (baseUrl && apiKey) {
    return glmEmbeddingProvider({ baseUrl, apiKey });
  }
  return deterministicEmbeddingProvider();
}

// ---------------------------------------------------------------------------
// 切片
// ---------------------------------------------------------------------------

const CHUNK_CHAR_SIZE = 500;
const CHUNK_OVERLAP = 80;

/**
 * 按字符切片,带重叠。
 *
 * 为什么按字符不按 token:中文一个字约等于 1 个 token,估得准;
 * 而引入 tokenizer 就多一个依赖,收益不足。重叠是为了不让一句话被切断在边界上 ——
 * 「离婚财产分割中,婚前财产」被切成两半,两边都检索不到完整语义。
 */
export function chunkText(text: string, chunkSize = CHUNK_CHAR_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const normalizedText = text.replace(/\r\n/g, "\n").trim();
  if (normalizedText.length === 0) return [];
  if (normalizedText.length <= chunkSize) return [normalizedText];

  const stride = Math.max(1, chunkSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < normalizedText.length; start += stride) {
    const chunk = normalizedText.slice(start, start + chunkSize).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (start + chunkSize >= normalizedText.length) break;
  }
  return chunks;
}
