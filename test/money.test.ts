import { test } from "node:test";
import assert from "node:assert/strict";
import {
  add, allocate, format, fromCents, fromDollars, mulQty, percentOf, sub,
} from "../src/domain/money.js";

test("fromDollars 不经过浮点乘法", () => {
  assert.equal(fromDollars(128.5), 12850);
  assert.equal(fromDollars("128.50"), 12850);
  assert.equal(fromDollars(0.1), 10);
  assert.equal(fromDollars(0.07), 7);
  // 经典浮点陷阱：1.005 * 100 在 IEEE754 下是 100.49999999999999
  assert.equal(fromDollars("1.005"), 101);
  assert.equal(fromDollars("2.675"), 268);
});

test("fromCents 拒绝非整数", () => {
  assert.throws(() => fromCents(10.5), RangeError);
});

test("累加不产生浮点误差", () => {
  // 0.1 + 0.2 !== 0.3 的整数版本
  const total = add(fromDollars("0.1"), fromDollars("0.2"));
  assert.equal(total, 30);
  assert.equal(format(total), "$0.30");
});

test("percentOf 按万分位精度计算，支持 QST 的 9.975%", () => {
  // 1000.00 的 9.975% = 99.75
  assert.equal(percentOf(fromDollars("1000.00"), 9.975), 9975);
  // 13% HST
  assert.equal(percentOf(fromDollars("1234.56"), 13), 16049); // 160.4928 → 160.49
  // 四舍五入进位
  assert.equal(percentOf(fromCents(1), 50), 1); // 0.5 分 → 1 分
});

test("mulQty 拒绝非法数量", () => {
  assert.equal(mulQty(fromDollars("12.34"), 3), 3702);
  assert.throws(() => mulQty(fromDollars("1.00"), 1.5), RangeError);
  assert.throws(() => mulQty(fromDollars("1.00"), -1), RangeError);
});

test("allocate 各份之和精确等于原值", () => {
  const parts = allocate(fromCents(100), 3);
  assert.deepEqual(parts, [34, 33, 33]);
  assert.equal(add(...parts), 100);

  const parts2 = allocate(fromCents(10), 4);
  assert.equal(add(...parts2), 10);
});

test("format 千分位与负数", () => {
  assert.equal(format(fromDollars("1234.5")), "$1,234.50");
  assert.equal(format(fromDollars("1234567.89")), "$1,234,567.89");
  assert.equal(format(sub(fromCents(0), fromDollars("12.34"))), "-$12.34");
  assert.equal(format(fromCents(5)), "$0.05");
});
