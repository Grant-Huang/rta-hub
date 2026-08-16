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

/**
 * 城市/省份名所在这句话是不是"问别处有没有服务"的句式（"Do you offer
 * installation in Surrey?"/"你们在温哥华有安装服务吗？"）——问的是"你们服务
 * 范围到不到那个地方"，不是客户在自报"我住那"。这类提及不能当成客户确认了
 * 自己的省份，否则客户随口问一句服务范围，账号省份就被这个不相关的城市名
 * 悄悄顶掉了（第三方测试报告 BUG-008）。
 *
 * 按"这一句话"整体判断，而不是只看城市名前面那一小段——中英文语序不同：
 * 英文通常是"服务词 + in + 地名"（城市在服务词后面），中文通常是
 * "在 + 地名 + 服务词"（城市在服务词前面），只查前文会漏掉中文这种。
 *
 * 只挡"问服务范围"这一种句式，不挡其他所有提及——`matchProvince("we're in
 * Montreal")` 这类自报句式必须继续认得。
 */
const SERVICE_QUESTION_EN =
  /\b(?:do\s+(?:you|they)|does\s+\w+|is\s+there|are\s+there)\b.*\b(?:install(?:ation)?|deliver(?:y)?|ship(?:ping)?|service|serve|offer|available|cover(?:age)?)\b|\b(?:install(?:ation)?|deliver(?:y)?|ship(?:ping)?|service|serve|offer|available|cover(?:age)?)\b.{0,60}\?\s*$/i;
const SERVICE_QUESTION_ZH =
  /(?:安装|配送|送货|服务|覆盖).{0,15}(?:吗|么)[？?]?\s*$|(?:你们|有没有|是否|能不能|可以).{0,20}(?:安装|配送|送货|服务|覆盖)/;

/** 把 matchIndex 所在的"这一句话"切出来（按常见句子分隔符断句）。 */
function sentenceAround(text: string, matchIndex: number): string {
  const SENTENCE_BOUNDARY = /[.?!。？！\n]/;
  let start = matchIndex;
  while (start > 0 && !SENTENCE_BOUNDARY.test(text[start - 1]!)) start--;
  let end = matchIndex;
  while (end < text.length && !SENTENCE_BOUNDARY.test(text[end]!)) end++;
  return text.slice(start, Math.min(text.length, end + 1));
}

function precedingContextAsksAboutElsewhere(text: string, matchIndex: number): boolean {
  const sentence = sentenceAround(text, matchIndex);
  return SERVICE_QUESTION_EN.test(sentence) || SERVICE_QUESTION_ZH.test(sentence);
}

/** 同一条正则的全局版——用于找出**所有**命中位置，逐个按上下文过滤。 */
function globalOf(re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, `${re.flags}g`);
}

/** 这条正则在文本里最后一处"不是在问别处服务范围"的命中位置；没有则 undefined。 */
function lastGenuineMatchIndex(re: RegExp, text: string): number | undefined {
  let last: number | undefined;
  for (const m of text.matchAll(globalOf(re))) {
    if (m.index === undefined) continue;
    if (precedingContextAsksAboutElsewhere(text, m.index)) continue;
    last = m.index;
  }
  return last;
}

/** 命中哪个省——供展示文案取标准名称/省码用。 */
export function matchProvince(text: string): ProvinceMatch | undefined {
  // 全名/城市优先；多个命中时取最后一次出现（后说的省份覆盖前面的）——但
  // "问别处有没有服务"这种提及不算数，见 precedingContextAsksAboutElsewhere。
  let best: { code: string; en: string; zh: string; index: number } | undefined;
  for (const p of PROVINCES) {
    const nameIdx = lastGenuineMatchIndex(p.nameRe, text);
    if (nameIdx !== undefined && (!best || nameIdx >= best.index)) {
      best = { code: p.code, en: p.en, zh: p.zh, index: nameIdx };
    }
    const codeIdx = lastGenuineMatchIndex(p.codeRe, text);
    // 省码权重略低：同一位置全名赢；更靠后的省码仍可覆盖
    if (codeIdx !== undefined && (!best || codeIdx > best.index)) {
      best = { code: p.code, en: p.en, zh: p.zh, index: codeIdx };
    }
  }
  return best ? { code: best.code, en: best.en, zh: best.zh } : undefined;
}

/** 是否已提到加拿大省份/地区（省名、省码，或该省的主要城市名）。 */
export function hasProvinceMention(text: string): boolean {
  return matchProvince(text) !== undefined;
}
