/**
 * 产出物下载：data URL 必须解码成原始字节，不能把字符串直接塞进 Blob。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactSourceToBytes } from "../web/artifact-blob.js";

/** 1×1 透明 PNG。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

test("data URL 解码后是 PNG 魔数，不是 data: 文本", () => {
  const out = artifactSourceToBytes(PNG_DATA_URL);
  assert.ok(out instanceof Uint8Array, "base64 data URL 应得到字节");
  const buf = Buffer.from(out);
  assert.equal(buf[0], 0x89);
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG");
  assert.deepEqual(buf, PNG_BYTES);
});

test("把 data URL 字符串直接当 Blob 内容会得到损坏文件（回归）", () => {
  const wronglyAsText = Buffer.from(PNG_DATA_URL, "utf8");
  assert.notEqual(wronglyAsText[0], 0x89, "UTF-8 文本不是 PNG");
  assert.equal(wronglyAsText.subarray(0, 5).toString("utf8"), "data:");
});

test("SVG 源码原样返回，不断成 data URL", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  assert.equal(artifactSourceToBytes(svg), svg);
});
