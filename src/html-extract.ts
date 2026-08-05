/**
 * 最小 HTML 正文提取：去 script/style/nav，保留标题、段落、列表文本。
 *
 * 与 let-it-flow 内部 `tools/builtin/web-fetch.ts` 的实现同源。之所以在这里留一份本地副本，
 * 是因为 `@meso.ai/let-it-flow` 目前没有从公共入口（`/runtime`）导出 `extractHtml`。
 * 等上游把它加进 runtime barrel 之后，这个文件可以整个删掉，改回从包里引入。
 */
export function extractHtml(html: string): { title: string; content: string } {
  let title = "";
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) title = stripTags(titleM[1] ?? "").trim();

  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const mainM = body.match(/<(?:main|article)[\s\S]*?>([\s\S]*?)<\/(?:main|article)>/i);
  const inner = mainM ? (mainM[1] ?? body) : body;

  const text = inner
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, content: text };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}
