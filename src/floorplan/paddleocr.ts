/**
 * PaddleOCR 抽取 —— 给 VL 模型（`ollama-vision.ts`）当"读数外援"。
 *
 * VL 模型擅长版面理解（哪段是墙、哪个记号是窗/门/上下水），但小字号的印刷/手写
 * 数字经常读串位（137 读成 132、144 读成 14 等）。PaddleOCR 这类专用文字识别器
 * 反过来擅长精确认字、不擅长版面语义。两者各管一段：OCR 只报"图上哪个位置写着
 * 什么字"，墙/特征的归属仍然交给 VL 模型判断——不建单独的合并/覆盖通路，避免
 * 又出现一套"这个数字该信谁"的第二判断（`ollama-vision.ts` 顶部注释讲的
 * "两份判断"坑，这里同理）。
 *
 * 端点是外部 HTTP 服务（`OCR_BASE_URL`），不是进程内 Python 调用——和 Ollama
 * 视觉模型同一个部署形状：本地跑一个小服务，Node 这边用 URL 接。配套的最小
 * PaddleOCR HTTP 包装见 `scripts/paddleocr_server.py`。
 */

export interface OcrToken {
  text: string;
  /** 识别置信度 0–1。 */
  score: number;
  /** 外接矩形左上角，占图像宽/高的百分比（0–100），与图像分辨率无关。 */
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface OcrExtractor {
  extract(input: { image: string; mimeType: string }): Promise<OcrToken[] | undefined>;
}

export interface PaddleOcrOptions {
  timeoutMs?: number;
}

/** 服务端返回的形状（`scripts/paddleocr_server.py` 的 `/ocr` 响应）。 */
interface PaddleOcrServerResponse {
  width?: number;
  height?: number;
  texts?: {
    text?: string;
    score?: number;
    /** 四点多边形像素坐标 [[x,y],[x,y],[x,y],[x,y]]，PaddleOCR 原生输出形状。 */
    box?: number[][];
  }[];
  error?: string;
}

export function createPaddleOcrExtractor(
  baseURL: string,
  opts: PaddleOcrOptions = {},
): OcrExtractor {
  const root = baseURL.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    async extract({ image }): Promise<OcrToken[] | undefined> {
      const b64 = stripDataUrl(image);
      if (!b64) return undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(`${root}/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ image: b64 }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PaddleOCR request failed (${root}/ocr): ${msg}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `PaddleOCR API error: ${response.status} ${response.statusText}` +
            (body ? ` — ${body.slice(0, 200)}` : ""),
        );
      }

      const data = (await response.json()) as PaddleOcrServerResponse;
      if (data.error) throw new Error(`PaddleOCR error: ${data.error}`);
      return toOcrTokens(data);
    },
  };
}

/** 从环境变量装配；没配就返回 undefined（VL 抽取照旧不带 OCR 外援）。 */
export function createPaddleOcrExtractorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OcrExtractor | undefined {
  const baseURL = env.OCR_BASE_URL?.trim();
  if (!baseURL) return undefined;
  return createPaddleOcrExtractor(baseURL);
}

/** 测试 / simulate 专用：读 `OCR_BASE_URL_TEST`，不碰生产 `OCR_BASE_URL`。 */
export function createPaddleOcrExtractorFromTestEnv(
  env: NodeJS.ProcessEnv = process.env,
): OcrExtractor | undefined {
  const baseURL = env.OCR_BASE_URL_TEST?.trim();
  if (!baseURL) return undefined;
  return createPaddleOcrExtractor(baseURL);
}

function toOcrTokens(data: PaddleOcrServerResponse): OcrToken[] {
  const width = data.width && data.width > 0 ? data.width : undefined;
  const height = data.height && data.height > 0 ? data.height : undefined;
  const rows = data.texts ?? [];
  const tokens: OcrToken[] = [];
  for (const row of rows) {
    const text = row.text?.trim();
    if (!text) continue;
    const box = row.box;
    if (!box || box.length < 3 || !width || !height) continue;
    const xs = box.map((p) => p[0] ?? 0);
    const ys = box.map((p) => p[1] ?? 0);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    tokens.push({
      text,
      score: typeof row.score === "number" ? row.score : 0.5,
      xPct: clampPct((x0 / width) * 100),
      yPct: clampPct((y0 / height) * 100),
      wPct: clampPct(((x1 - x0) / width) * 100),
      hPct: clampPct(((y1 - y0) / height) * 100),
    });
  }
  return tokens;
}

function clampPct(v: number): number {
  return Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
}

/**
 * 把 OCR token 列表压成给 VL 提示词看的一段文本——按阅读顺序（先按行再按列）
 * 排序，去掉低置信度噪声，截断避免把提示词撑爆。
 */
export function formatOcrGroundingBlock(
  tokens: readonly OcrToken[],
  opts: { minScore?: number; maxTokens?: number } = {},
): string | undefined {
  const minScore = opts.minScore ?? 0.5;
  const maxTokens = opts.maxTokens ?? 80;

  const kept = tokens
    .filter((t) => t.text && t.score >= minScore)
    .sort((a, b) => (Math.round(a.yPct / 3) - Math.round(b.yPct / 3)) || (a.xPct - b.xPct))
    .slice(0, maxTokens);

  if (!kept.length) return undefined;

  return kept
    .map((t) => `"${t.text}" at (${t.xPct.toFixed(0)}%,${t.yPct.toFixed(0)}%)`)
    .join("\n");
}

/** PaddleOCR 的 `images` 也要裸 base64，不要 data URL 前缀——和 Ollama 一致。 */
function stripDataUrl(image: string): string {
  const s = image.trim();
  const m = /^data:[^;]+;base64,(.+)$/i.exec(s);
  return (m?.[1] ?? s).replace(/\s+/g, "");
}
