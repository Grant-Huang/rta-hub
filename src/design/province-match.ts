/**
 * 省份口语匹配——省名 / 省码 / 主要城市名，中英文都要认得。
 *
 * 这是唯一权威数据源。之前 `hasProvinceMention`（orchestrator.ts 的 intake
 * 判定用）和 `matchProvince`（readiness.ts 的展示文案用）各自维护一份正则，
 * 同一批省份/城市收得不一样——比如"多伦多"两边都认得，但客户直接说英文城市名
 * "Toronto" 时两份正则都不认（只收了省名/省码，没收城市英文名），且当时只覆盖
 * ON/BC/AB/QC 四省，其余 9 个省/地区完全没有城市名匹配。两份数据不同步是根因，
 * 不是漏收了哪个词就补哪个词能治好的，所以合并成一份，两边都从这里导入。
 */

export interface ProvinceMatch {
  code: string;
  en: string;
  zh: string;
}

interface ProvinceEntry extends ProvinceMatch {
  /** 全名 / 城市 / 「XX省」——大小写不敏感。 */
  nameRe: RegExp;
  /** 两字母省码。ON 单独处理（避免撞上英语介词 "on"），其余大小写不敏感。 */
  codeRe: RegExp;
}

function codeRegex(code: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z])${code}(?:[^A-Za-z]|$)`, "i");
}

const PROVINCES: ProvinceEntry[] = [
  {
    code: "BC", en: "British Columbia", zh: "不列颠哥伦比亚省",
    nameRe: /british\s*columbia|不列颠|温哥华|维多利亚|素里|bc\s*省|\bvancouver\b|\bvictoria\b|\bsurrey\b|\bburnaby\b/i,
    codeRe: codeRegex("BC"),
  },
  {
    code: "AB", en: "Alberta", zh: "阿尔伯塔省",
    nameRe: /alberta|阿尔伯塔|卡尔加里|埃德蒙顿|ab\s*省|\bcalgary\b|\bedmonton\b/i,
    codeRe: codeRegex("AB"),
  },
  {
    code: "SK", en: "Saskatchewan", zh: "萨斯喀彻温省",
    nameRe: /saskatchewan|萨斯喀彻温|萨斯省|sk\s*省|\bregina\b|\bsaskatoon\b/i,
    codeRe: codeRegex("SK"),
  },
  {
    code: "MB", en: "Manitoba", zh: "曼尼托巴省",
    nameRe: /manitoba|曼尼托巴|mb\s*省|\bwinnipeg\b/i,
    codeRe: codeRegex("MB"),
  },
  {
    code: "QC", en: "Quebec", zh: "魁北克省",
    nameRe: /quebec|québec|魁北克|蒙特利尔|qc\s*省|\bmontreal\b|\bmontréal\b/i,
    codeRe: codeRegex("QC"),
  },
  {
    code: "ON", en: "Ontario", zh: "安大略省",
    // "on" 是英语高频介词，不能像其它省码一样大小写不敏感地裸匹配——
    // 小写只在带「省」时才算数；大写 "ON" 才无条件算数（放进 codeRe）。
    nameRe: /ontario|安大略|多伦多|渥太华|密西沙加|汉密尔顿|(?:^|[^a-zA-Z])on\s*省\b|\btoronto\b|\bottawa\b|\bmississauga\b|\bhamilton\b|\blondon,?\s*on(?:tario)?\b/i,
    codeRe: /(?:^|[^A-Za-z])ON(?:[^A-Za-z]|$)/,
  },
  {
    code: "NB", en: "New Brunswick", zh: "新不伦瑞克省",
    nameRe: /new\s*brunswick|新不伦瑞克|nb\s*省|\bfredericton\b|\bmoncton\b|\bsaint\s*john\b/i,
    codeRe: codeRegex("NB"),
  },
  {
    code: "NS", en: "Nova Scotia", zh: "新斯科舍省",
    nameRe: /nova\s*scotia|新斯科舍|ns\s*省|\bhalifax\b/i,
    codeRe: codeRegex("NS"),
  },
  {
    code: "PE", en: "Prince Edward Island", zh: "爱德华王子岛省",
    nameRe: /prince\s*edward\s*island|爱德华王子岛|pe\s*省|\bcharlottetown\b/i,
    codeRe: codeRegex("PE"),
  },
  {
    code: "NL", en: "Newfoundland and Labrador", zh: "纽芬兰与拉布拉多省",
    nameRe: /newfoundland|拉布拉多|纽芬兰|nl\s*省|st\.?\s*john's/i,
    codeRe: codeRegex("NL"),
  },
  {
    code: "YT", en: "Yukon", zh: "育空地区",
    nameRe: /yukon|育空|yt\s*省|\bwhitehorse\b/i,
    codeRe: codeRegex("YT"),
  },
  {
    code: "NT", en: "Northwest Territories", zh: "西北地区",
    nameRe: /northwest\s*territories|西北地区|nt\s*省|\byellowknife\b/i,
    codeRe: codeRegex("NT"),
  },
  {
    code: "NU", en: "Nunavut", zh: "努纳武特地区",
    nameRe: /nunavut|努纳武特|nu\s*省|\biqaluit\b/i,
    codeRe: codeRegex("NU"),
  },
];

/** 按省码查标准名称——账号上已有省份代码时，不需要正则匹配，直接查表。 */
export function provinceByCode(code: string): ProvinceMatch | undefined {
  const p = PROVINCES.find((p) => p.code === code);
  return p ? { code: p.code, en: p.en, zh: p.zh } : undefined;
}

/** 命中哪个省——供展示文案取标准名称/省码用。 */
export function matchProvince(text: string): ProvinceMatch | undefined {
  // 全名/城市优先；多个命中时取最后一次出现（后说的省份覆盖前面的）。
  let best: { code: string; en: string; zh: string; index: number } | undefined;
  for (const p of PROVINCES) {
    const nameHit = p.nameRe.exec(text);
    if (nameHit && nameHit.index !== undefined) {
      if (!best || nameHit.index >= best.index) {
        best = { code: p.code, en: p.en, zh: p.zh, index: nameHit.index };
      }
    }
    const codeHit = p.codeRe.exec(text);
    if (codeHit && codeHit.index !== undefined) {
      // 省码权重略低：同一位置全名赢；更靠后的省码仍可覆盖
      const idx = codeHit.index;
      if (!best || idx > best.index) {
        best = { code: p.code, en: p.en, zh: p.zh, index: idx };
      }
    }
  }
  return best ? { code: best.code, en: best.en, zh: best.zh } : undefined;
}

/** 是否已提到加拿大省份/地区（省名、省码，或该省的主要城市名）。 */
export function hasProvinceMention(text: string): boolean {
  return matchProvince(text) !== undefined;
}
