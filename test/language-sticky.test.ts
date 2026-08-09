/**
 * 语言跟随：短英文尺寸/封口句不得把已建立的中文会话切回英文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferLanguageFromText,
  isLanguageNoiseDump,
  shouldUpdateLanguageFromText,
} from "../src/i18n/language.js";

test("Fridge 36 这类封口句视为噪声堆", () => {
  assert.equal(isLanguageNoiseDump('Fridge 36", stove 30", dishwasher 24".'), true);
  assert.equal(isLanguageNoiseDump("assumed widths are fine"), true);
  assert.equal(isLanguageNoiseDump("我们家厨房要整个翻新，想换成现代简约的灰调"), false);
});

test("已中文会话时，英文尺寸封口不翻转语言", () => {
  const seal = 'Fridge 36", range 30". Ontario ON.';
  const inferred = inferLanguageFromText(seal);
  assert.equal(inferred, "en");
  assert.equal(
    shouldUpdateLanguageFromText("zh", inferred, seal, false),
    false,
  );
  assert.equal(
    shouldUpdateLanguageFromText("zh", "en", "用英文回答", true),
    true,
  );
});
