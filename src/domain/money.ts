/**
 * 金额类型 —— 一律用「最小货币单位的整数」（加币分）运算，绝不使用浮点数。
 *
 * 理由见 PRE_LAUNCH_CHECKLIST.md C1：报价金额错一分钱就是对外发出的错误报价。
 * 0.1 + 0.2 !== 0.3 这类浮点误差在逐行累加的报价单上会真实地累积出偏差。
 */

/** 金额，单位为分（cents）。恒为整数。 */
export type Money = number & { readonly __brand: "Money" };

export const ZERO = 0 as Money;

/** 从「分」构造。入参必须已经是整数。 */
export function fromCents(cents: number): Money {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`Money 必须是整数分，收到 ${cents}`);
  }
  return cents as Money;
}

/**
 * 从「元」构造（如价目表里的 128.50）。
 *
 * 用字符串路径解析而不是 `Math.round(dollars * 100)`，因为后者对
 * 1.005 这类值会因浮点表示误差进错方向。
 */
export function fromDollars(dollars: number | string): Money {
  const s = typeof dollars === "number" ? dollars.toFixed(4) : dollars.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`无法解析金额：${dollars}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] ?? "0";
  const frac = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2));
  // 第三位小数用于四舍五入（银行家舍入不适用于报价场景，用常规四舍五入）
  const third = Number(frac[2] ?? "0");
  return fromCents(sign * (cents + (third >= 5 ? 1 : 0)));
}

export function add(...values: Money[]): Money {
  return fromCents(values.reduce((a, b) => a + b, 0));
}

export function sub(a: Money, b: Money): Money {
  return fromCents(a - b);
}

/** 乘以一个整数数量。 */
export function mulQty(amount: Money, qty: number): Money {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError(`数量必须是非负整数，收到 ${qty}`);
  }
  return fromCents(amount * qty);
}

/**
 * 按百分比取值并四舍五入到分。
 *
 * `percent` 用「百分数」表示（13 表示 13%），支持小数（QC 的 QST 是 9.975%）。
 * 内部先放大到万分位做整数运算，避免 amount * 0.09975 的浮点误差。
 */
export function percentOf(amount: Money, percent: number): Money {
  const scaled = Math.round(percent * 1000); // 万分之一精度：9.975% -> 9975
  const product = amount * scaled;
  return fromCents(roundHalfAwayFromZero(product, 100_000));
}

/** numerator / denominator，四舍五入（远离零方向），返回整数。 */
function roundHalfAwayFromZero(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  return sign * Math.floor((abs + denominator / 2) / denominator);
}

/**
 * 把一个金额按份数均分，保证各份之和 === 原值。
 * 余数分配给前面的份（不产生「分」的丢失）。
 */
export function allocate(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`份数必须是正整数，收到 ${parts}`);
  }
  const base = Math.trunc(amount / parts);
  const remainder = amount - base * parts;
  const out: Money[] = [];
  for (let i = 0; i < parts; i++) {
    out.push(fromCents(base + (i < Math.abs(remainder) ? Math.sign(remainder) : 0)));
  }
  return out;
}

/** 格式化为显示字符串，如 `$1,234.50`。 */
export function format(amount: Money, currency = "CAD"): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const whole = Math.trunc(abs / 100).toString();
  const cents = (abs % 100).toString().padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "CAD" || currency === "USD" ? "$" : "";
  return `${sign}${symbol}${grouped}.${cents}`;
}

export function toDollarsNumber(amount: Money): number {
  return amount / 100;
}
