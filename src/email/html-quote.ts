/**
 * HTML 报价邮件 —— FR-7、SCENARIOS 场景 E 第 7 点。
 *
 * 四层兜底（v0.2 已关闭的问题 6）：
 *   1. **CID 内嵌图片**：四视图直接嵌在正文里；
 *   2. **HTML 表格**：价格明细也在正文里，不靠附件；
 *   3. **纯文本兜底**：不支持 HTML 的客户端也能读全；
 *   4. **图片附件兜底**：图片被邮件客户端拦截时，附件里还有一份。
 *
 * SVG 在邮件客户端里支持很差（Gmail/Outlook 基本不渲染），所以内嵌图统一转成
 * **PNG data URI 的替代方案不可行**（体积大且仍需转换）。这里的做法是：
 * SVG 作为附件保留，正文内嵌用 CID 引用同一份附件，由发信侧决定是否预转 PNG。
 *
 * 邮件默认英文（发给加拿大商家）。
 */
import { format } from "../domain/money.js";
import type { Quote } from "../domain/types.js";
import type { FourViews } from "../render/views.js";

export interface EmailAttachment {
  /** 附件文件名。 */
  filename: string;
  /** CID，用于正文 `<img src="cid:...">` 引用。 */
  cid: string;
  contentType: string;
  /** 内容（SVG 是文本，PNG 是 base64）。 */
  content: string;
  encoding?: "utf-8" | "base64";
}

export interface HtmlQuoteEmail {
  subject: string;
  html: string;
  /** 纯文本兜底版本——内容完整，不是"请用 HTML 查看"这种敷衍。 */
  text: string;
  attachments: EmailAttachment[];
}

export interface HtmlQuoteInput {
  quote: Quote;
  companyName: string;
  customerName: string;
  customerEmail: string;
  /** 每段墙的四视图。 */
  viewsByRun: { runLabel: string; views: FourViews }[];
  senderName: string;
  senderContact?: string;
}

const VIEW_LABELS: Record<keyof FourViews, string> = {
  front: "Front elevation",
  topBase: "Plan · base",
  topWall: "Plan · wall",
  side: "Side section",
};

export function buildHtmlQuoteEmail(input: HtmlQuoteInput): HtmlQuoteEmail {
  const { quote: q } = input;
  const attachments: EmailAttachment[] = [];

  // 每张视图既是内嵌图（CID）又是附件（兜底）
  const imageBlocks: string[] = [];
  input.viewsByRun.forEach((run, runIndex) => {
    const blocks: string[] = [];
    for (const key of ["front", "topBase", "topWall", "side"] as (keyof FourViews)[]) {
      const cid = `view-${runIndex}-${key}@rta-hub`;
      const filename = `${sanitize(run.runLabel)}-${key}.svg`;
      attachments.push({
        filename, cid, contentType: "image/svg+xml",
        content: run.views[key], encoding: "utf-8",
      });
      blocks.push(`
        <div style="margin:0 0 18px">
          <div style="font-size:12px;color:#666;margin-bottom:4px">${escapeHtml(VIEW_LABELS[key])}</div>
          <img src="cid:${cid}" alt="${escapeHtml(run.runLabel)} ${escapeHtml(VIEW_LABELS[key])}"
               style="max-width:100%;border:1px solid #e0e0e0"/>
        </div>`);
    }
    imageBlocks.push(`
      <h3 style="font-size:14px;margin:20px 0 8px">${escapeHtml(run.runLabel)}</h3>
      ${blocks.join("")}`);
  });

  const lineRows = q.lineItems.map((l) => `
    <tr>
      <td style="padding:5px 6px;border-bottom:1px solid #eee">${escapeHtml(l.moduleCode)}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eee;color:#666">${l.width}&quot; &times; ${l.height}&quot; &times; ${l.depth}&quot;</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right">${l.qty}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right">${format(l.unitListPrice)}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right">${format(l.unitNetPrice)}</td>
      <td style="padding:5px 6px;border-bottom:1px solid #eee;text-align:right">${format(l.lineSubtotal)}</td>
    </tr>`).join("");

  const summaryRows = [
    ["Subtotal", format(q.subtotal)],
    ...q.discounts.map((d) => [d.description, `-${format(d.amount)}`] as [string, string]),
    ["Shipping", format(q.shipping.amount)],
    ...q.taxes.map((t) => [`${t.name} ${t.ratePercent}%`, format(t.amount)] as [string, string]),
  ].map(([label, value]) => `
    <tr><td style="padding:3px 6px;text-align:right;color:#555">${escapeHtml(label ?? "")}</td>
        <td style="padding:3px 6px;text-align:right;width:110px">${escapeHtml(value ?? "")}</td></tr>`).join("");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:760px;color:#222">
  <p>Hello ${escapeHtml(input.companyName)} team,</p>
  <p>A customer on our platform (${escapeHtml(input.customerName)}, ${escapeHtml(q.province)}) finished a kitchen cabinet design
     and confirmed sending this quote request to you.</p>

  <h2 style="font-size:15px;border-bottom:2px solid #333;padding-bottom:4px;margin-top:24px">Design</h2>
  ${imageBlocks.join("")}

  <h2 style="font-size:15px;border-bottom:2px solid #333;padding-bottom:4px;margin-top:24px">Price details</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:2px solid #ddd">
      <th style="text-align:left;padding:6px">SKU</th>
      <th style="text-align:left;padding:6px">Size</th>
      <th style="text-align:right;padding:6px">Qty</th>
      <th style="text-align:right;padding:6px">List</th>
      <th style="text-align:right;padding:6px">Net</th>
      <th style="text-align:right;padding:6px">Line</th>
    </tr></thead>
    <tbody>${lineRows}</tbody>
  </table>

  <table style="margin-left:auto;margin-top:12px;font-size:13px">
    ${summaryRows}
    <tr style="border-top:2px solid #333">
      <td style="padding:7px 6px;text-align:right;font-weight:600">Total (${escapeHtml(q.currency)})</td>
      <td style="padding:7px 6px;text-align:right;font-weight:600;font-size:15px">${format(q.total)}</td>
    </tr>
  </table>

  <p style="font-size:12px;color:#777">Door style ${escapeHtml(q.doorStyleId)} · Valid until ${escapeHtml(q.validUntil.slice(0, 10))}</p>

  <h2 style="font-size:15px;border-bottom:2px solid #333;padding-bottom:4px;margin-top:24px">Customer contact</h2>
  <p>${escapeHtml(input.customerName)} &lt;${escapeHtml(input.customerEmail)}&gt;<br/>
     Quote ID: ${escapeHtml(q.id)}</p>

  <p style="font-size:12px;color:#777;margin-top:24px;border-top:1px solid #eee;padding-top:10px">
    This is a one-time inquiry the customer confirmed — not a marketing message.<br/>
    ${escapeHtml(input.senderName)}${input.senderContact ? ` · ${escapeHtml(input.senderContact)}` : ""}<br/>
    If images do not display, the same four views are attached to this email.
  </p>
</div>`.trim();

  return {
    subject: `[Quote request] Kitchen cabinets · ${q.id}`,
    html,
    text: buildPlainText(input),
    attachments,
  };
}

/**
 * 纯文本兜底版本。
 *
 * 内容是**完整的**——包含全部明细与联系方式，不是"请用支持 HTML 的客户端查看"。
 * 视图无法用纯文本表达，故指向附件。
 */
function buildPlainText(input: HtmlQuoteInput): string {
  const q = input.quote;
  const lines = q.lineItems.map((l) =>
    `  ${l.moduleCode.padEnd(10)} ${l.width}"x${l.height}"x${l.depth}"  x${String(l.qty).padStart(2)}  ` +
    `${format(l.unitNetPrice).padStart(10)}  ${format(l.lineSubtotal).padStart(11)}`);

  return [
    `Hello ${input.companyName} team,`,
    "",
    `A customer on our platform (${input.customerName}, ${q.province}) finished a kitchen cabinet design`,
    "and confirmed sending this quote request to you.",
    "",
    "[Design]",
    ...input.viewsByRun.map((r) =>
      `  ${r.runLabel}: front / plan·base / plan·wall / side — see attachments`),
    "",
    "[Price details]",
    "  SKU         Size                Qty         Net           Line",
    "  " + "-".repeat(62),
    ...lines,
    "  " + "-".repeat(62),
    `  Subtotal: ${format(q.subtotal)}`,
    ...q.discounts.map((d) => `  ${d.description}: -${format(d.amount)}`),
    `  Shipping: ${format(q.shipping.amount)}`,
    ...q.taxes.map((t) => `  ${t.name} ${t.ratePercent}%: ${format(t.amount)}`),
    `  Total (${q.currency}): ${format(q.total)}`,
    "",
    `  Valid until ${q.validUntil.slice(0, 10)}`,
    "",
    "[Customer contact]",
    `  ${input.customerName} <${input.customerEmail}>`,
    `  Quote ID: ${q.id}`,
    "",
    "This is a one-time inquiry the customer confirmed — not a marketing message.",
    "",
    "———",
    input.senderName,
    input.senderContact ? `Contact: ${input.senderContact}` : "",
  ].filter((l) => l !== "").join("\n");
}

function sanitize(name: string): string {
  return name.replace(/[^\w一-龥-]+/g, "_");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
