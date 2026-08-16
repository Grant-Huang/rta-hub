/**
 * 户型图的视觉抽取 —— **走没走、为什么没读出东西，都要说出来**。
 *
 * 第二轮测试报告的第 3 条是「视觉模型尚未测试」。查下来的原因不是没测：
 * **是从界面上根本测不了**——上传只传了文件名、类型和大小，图片内容一次都
 * 没传上去，服务端拿到的 `image` 永远是 undefined，于是无论配没配模型、
 * 端点对不对，结果都一样落到"请手动录入尺寸"。
 *
 * 所以这里盯两件事：
 *   1. 有图有模型时**真的会调**；
 *   2. 四种"没读出东西"要能分辨开——没配模型 / 没收到图 / 模型报错 / 图太糊。
 *      都退化成同一句话的话，配错了的人永远不知道自己配错了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFloorPlanWithOutcome, extractionNote, interpretationSummary, type VisionExtractor,
} from "../src/floorplan/parse.js";

const input = {
  conversationId: "c_x",
  file: { name: "k.png", mimeType: "image/png", sizeBytes: 1024 },
  at: "2026-03-01T00:00:00.000Z",
};

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

const stub = (impl: VisionExtractor["extract"]): VisionExtractor => ({ extract: impl });

test("有图有模型：真的把图交给了模型，抽出来的墙段进了户型", async () => {
  let got: { image: string; mimeType: string } | undefined;
  const { plan, extraction } = await createFloorPlanWithOutcome(input, IMAGE, stub(async (i) => {
    got = { image: i.image, mimeType: i.mimeType };
    return {
      ceilingHeight: 96, ceilingHeightConfidence: 0.9,
      wallRuns: [{ label: "北墙", length: 144, lengthConfidence: 0.9 }],
    };
  }));

  assert.equal(got?.image, IMAGE, "模型没收到图片内容——上传那条路多半又只传了元数据");
  assert.equal(got?.mimeType, "image/png");
  assert.equal(extraction.status, "ok");
  assert.equal(plan.parsedGeometry.wallRuns.length, 1);
  assert.equal(plan.parsedGeometry.wallRuns[0]?.length, 144);
  assert.equal(extractionNote(extraction, "zh"), undefined, "一切正常时不该多说一句");
});

test("没收到图：说清是「没收到图」，不含糊成「模型读不出来」", async () => {
  let called = false;
  const { extraction } = await createFloorPlanWithOutcome(
    input, undefined, stub(async () => { called = true; return undefined; }));
  assert.equal(called, false);
  assert.equal(extraction.status, "noImage");
  assert.match(extractionNote(extraction, "zh")!, /没收到图片内容/);
});

test("没配模型：说的是「没配」，并指向手动录入", async () => {
  const { extraction } = await createFloorPlanWithOutcome(input, IMAGE, undefined);
  assert.equal(extraction.status, "notConfigured");
  assert.match(extractionNote(extraction, "zh")!, /没有配置视觉模型/);
});

test("模型报错：上传照样成功，但**原因原样说出来**", async () => {
  // 抽取失败不该让上传失败——手动录入这条路一直是通的（FR-3 的降级设计）。
  // 但把原因吞掉，配错端点的人只会看到一句"请手动录入"，永远查不到问题在哪。
  const { plan, extraction } = await createFloorPlanWithOutcome(
    input, IMAGE, stub(async () => { throw new Error("HTTP 404 /v1/chat/completions"); }));

  assert.ok(plan.id, "抽取失败把整次上传也弄失败了");
  assert.equal(extraction.status, "failed");
  assert.equal(extraction.status === "failed" && extraction.reason, "HTTP 404 /v1/chat/completions");
  assert.match(extractionNote(extraction, "zh")!, /HTTP 404/, "报错原因没传给客户");
  assert.match(extractionNote(extraction, "zh")!, /端点配置/, "没告诉人该去查哪儿");
});

test("模型读不出东西：与「报错」分开说——图糊和配置错要做的事不一样", async () => {
  const { extraction } = await createFloorPlanWithOutcome(
    input, IMAGE, stub(async () => undefined));
  assert.equal(extraction.status, "emptyResult");
  assert.match(extractionNote(extraction, "zh")!, /太模糊|标注不清/);
});

test("读图回话末尾带排障标记——OCR 有没有真的兜底，客户看不出但运营能查", async () => {
  const withOcr = await createFloorPlanWithOutcome(input, IMAGE, stub(async () => ({
    wallRuns: [{ label: "北墙", length: 144, lengthConfidence: 0.9 }],
    ocrGrounded: true,
  })));
  const withoutOcr = await createFloorPlanWithOutcome(input, IMAGE, stub(async () => ({
    wallRuns: [{ label: "北墙", length: 137, lengthConfidence: 0.9 }],
  })));

  assert.match(
    interpretationSummary(withOcr.plan, withOcr.extraction, "zh"),
    /\[g:ocr\+vl\]$/,
    "OCR 真的兜底了应该在结尾留痕",
  );
  assert.match(
    interpretationSummary(withoutOcr.plan, withoutOcr.extraction, "zh"),
    /\[g:vl\]$/,
    "OCR 没生效（没配/失败/未触发）不该冒充成兜底过",
  );
});

test("四种情况的说法互不相同——都一样就等于什么也没说", () => {
  const notes = [
    extractionNote({ status: "notConfigured" }, "zh"),
    extractionNote({ status: "noImage" }, "zh"),
    extractionNote({ status: "emptyResult" }, "zh"),
    extractionNote({ status: "failed", reason: "x" }, "zh"),
  ];
  assert.equal(new Set(notes).size, 4, `四种情况说了重复的话：${notes.join(" | ")}`);
  // 每一种都要给出下一步——只说"读不了"而不说接下来干什么，客户就卡在这儿了
  for (const n of notes) {
    assert.match(n!, /手动|手填|填尺寸|录入/, `这一条没说下一步该干什么：${n}`);
  }
});
