/**
 * 测试场景生成 —— 由 LLM 动态产出，不是写死的剧本。
 *
 * ## 为什么要动态生成
 *
 * 手写的场景有个根本问题：**它们只覆盖我想得到的情况**。我写三套厨房，
 * 就只有我预设的那三种形状、那三种偏好组合。真实客户会给出我没想到的
 * 尺寸、说我没预料到的话、选我没试过的组合——而那些正是会出问题的地方。
 *
 * 所以场景由 LLM 生成，并**显式要求它覆盖各类边界**（见 SYSTEM）。
 *
 * ## 没有 API key 时怎么办
 *
 * 回退到一个**确定性的伪随机生成器**（种子固定 → 可复现）。它比手写剧本
 * 覆盖面广（会随机组合尺寸/偏好/形状），但比 LLM 少了"说人话的多样性"。
 *
 * 这个回退是必须的：CI 不该依赖外部 API，否则没有 key 的人跑不了冒烟测试。
 * 但回退时会**在输出里明确标注**，不让人误以为跑的是 LLM 生成的场景。
 */
import type { CompletionClient } from "../src/agents/types.js";

export interface ScenarioWall {
  label: string;
  length: number;
  features: { kind: "window" | "plumbing" | "gas" | "electrical" | "door"; offset: number; width: number }[];
  /** 岛台。不接任何墙，四周都是过道——过道净空由排布器判。 */
  kind?: "wall" | "island";
  /** 岛台进深（英寸）。单排柜约 25"。 */
  depth?: number;
}

/** 仅注入 user agent 的私有事实（FR-20）——系统侧不得读取。 */
export interface CustomerFacts {
  intent?: string;
  kitchenTalk?: string;
  walls?: { label: string; length: number }[];
  ceilingHeight?: number;
  style?: string;
  budget?: string;
  province?: string;
  appliances?: string;
  plumbing?: string;
  windows?: string;
  mentionCompany?: string;
  notes?: string;
}

export interface Scenario {
  id: string;
  name: string;
  shape: string;
  /** 覆盖意图——这个场景是冲着哪个边界去的。 */
  covers: string;
  accountType: "consumer" | "trade";
  /**
   * @deprecated 保留兼容；模拟优先用 user agent + customerFacts（FR-20）。
   * 不再把 turns 当「客户主动报齐」的剧本。
   */
  turns: string[];
  /**
   * 客户私有意图——只给 user agent，不给系统 LLM。
   */
  customerFacts?: CustomerFacts;
  ceilingHeight: number;
  walls: ScenarioWall[];
  /**
   * 这个厨房里的家电（FR-3.2）。
   *
   * 不给就走 `DEFAULT_APPLIANCES`（冰箱 + 灶具，标为推定值）。给了才测得到
   * 「按实际尺寸留空」「推定值如实披露」「配套柜按能力标签查」这几条——
   * 而那正是场景 J 要覆盖的。
   *
   * `width` 省略表示客户说"不确定"：系统按常见档位取值并标 `provenance: "assumed"`，
   * 解释里必须写明它是推定的。
   */
  appliances?: {
    kind: "refrigerator" | "range" | "cooktop" | "wallOven" | "rangeHood" | "microwave" | "dishwasher";
    width?: number;
    preferredZone?: "nearEntry" | "nearSink" | "nearWindow" | "any";
  }[];
  prefs: {
    budgetBand?: "economy" | "standard" | "premium" | "unsure";
    doorStyleId?: string;
    storage?: "drawers" | "doors" | "balanced";
    assembly?: "RTA" | "assembled";
    hardwareOptionIds?: string[];
    accessoryOptionIds?: string[];
    tradeoff?: "price" | "quality" | "lookAndFeel";
    layoutHints?: {
      includeSpicePullout?: boolean;
      includeTrashPullout?: boolean;
      enlargeIslandInches?: number;
      matchCabinetNos?: number[];
      doubleDrawerNos?: number[];
      spiceCabinetNo?: number;
      spiceNear?: "range" | "cooktop" | "sink";
      trashCabinetNo?: number;
      trashNear?: "range" | "cooktop" | "sink";
    };
  };
  /**
   * 客户在全局俯视图阶段提的修改——用**意图**表达，不写死不存在的 SKU。
   *
   * `note`（含真实 #N）由模拟器在见到第一版柜号索引后再生成；
   * 静态 note 仅用于不含柜号/型号的口语意图。
   */
  revisions: ScenarioRevision[];
  /**
   * 可选：上传 `test/sources/` 下的真实户型图（相对该目录的文件名）。
   * 模拟器会把整图以 data URL 交给 `/floorplan`，再按 walls 补齐/确认尺寸。
   */
  sourceImage?: string;
}

/** 修订意图——禁止在场景里写死 B12 等可能本版不存在的 SKU。 */
export type RevisionIntent =
  | "spice_near_cooktop"
  | "trash_pullout"
  | "more_drawers"
  | "doors_over_drawers"
  | "enlarge_island"
  | "double_drawer"
  | "sink_under_window"
  | "swap_door_style"
  | "unactionable";

export interface ScenarioRevision {
  /** 结构化意图（权威）；模拟器据此生成 note / 补全 #N。 */
  intent: RevisionIntent;
  /**
   * 可选口语；若含 #N/型号须在见到首版图后由模拟器填写。
   * 场景定义阶段不要写死 B12。
   */
  note?: string;
  /** 可选偏好改动；意图解析器可再合并 spiceCabinetNo 等。 */
  changes?: Scenario["prefs"];
}

export interface ScenarioSet {
  scenarios: Scenario[];
  /** 场景是怎么来的——LLM 还是确定性回退。输出里必须如实标注。 */
  source: "llm" | "deterministic";
  note: string;
}

const SYSTEM = [
  "你在为一个加拿大 RTA 橱柜设计与报价平台生成**测试场景**。",
  "目标是**覆盖边界**，不是生成好看的样例。请刻意制造会让系统为难的情况。",
  "",
  "必须覆盖的维度（在你生成的这批场景里合起来覆盖到）：",
  "1. 形状：一字型（1 段墙）、L 型（2 段）、U 型（3 段）各至少一个；",
  "2. 尺寸边界：至少一个**很小**的厨房（单墙 < 90 英寸）和一个**很大**的（单墙 > 180 英寸）；",
  "3. 特征：有窗/无窗、上下水在墙中间/靠边、有门洞的墙；",
  "4. 偏好：economy 与 premium 各至少一个；storage 三种取值都要出现；",
  "   至少一个选 assembled（组装好发货）——注意吊柜通常只提供 RTA；",
  "5. 账号：至少一个 trade（建商）账号；",
  "6. 层高：至少一个非 96 英寸的（如 108）；",
  "7. 对话：客户的说法要口语化、含糊、有时答非所问——**不要都用标准术语**。",
  "   至少一个场景里客户用系统关键词表里没有的说法描述风格（如「质感」「高级灰」）。",
  "",
  "硬性约束（违反会让场景跑不起来）：",
  "- 墙段长度 30–240 英寸之间，1/4 英寸的整数倍；",
  "- 特征的 offset + width 必须 ≤ 该墙段长度；",
  "- doorStyleId 只能从给定清单里选；hardwareOptionIds / accessoryOptionIds 同理；",
  "- revisions 取 0–3 条。每条必须有 intent（spice_near_cooktop|trash_pullout|more_drawers|",
  "  doors_over_drawers|enlarge_island|double_drawer|sink_under_window|swap_door_style|unactionable）；",
  "  **禁止**在 note 里写死 B12 等具体型号；#N 由模拟器见首版图后再填。",
  "  changes 可选。**至少有一条 intent=unactionable**——模拟客户提了句",
  "  系统落不下去的话（如「看着大气一点」），要验证系统会如实说「这轮没有改动」",
  "  而不是假装改过了。",
].join("\n");

const SCHEMA_HINT = `{
  "scenarios": [{
    "id": "A", "name": "简短的场景名", "shape": "一字型|L 型|U 型",
    "covers": "这个场景冲着哪个边界去的",
    "accountType": "consumer|trade",
    "turns": ["客户第一句", "第二句", "..."],
    "ceilingHeight": 96,
    "walls": [{ "label": "北墙", "length": 144,
      "features": [{ "kind": "window", "offset": 54, "width": 36 }] }],
    "prefs": { "budgetBand": "standard", "doorStyleId": "ds_shaker_white",
      "storage": "balanced", "assembly": "RTA",
      "hardwareOptionIds": [], "accessoryOptionIds": [], "tradeoff": "price" },
    "revisions": [
      { "intent": "more_drawers", "changes": { "storage": "drawers" } },
      { "intent": "unactionable" }
    ]
  }]
}`;

export interface GenerateInput {
  client: CompletionClient | undefined;
  count: number;
  doorStyleIds: readonly string[];
  hardwareIds: readonly string[];
  accessoryIds: readonly string[];
  /** 固定种子，让确定性回退可复现。 */
  seed?: number;
}

export async function generateScenarios(input: GenerateInput): Promise<ScenarioSet> {
  if (input.client?.completeJson) {
    const raw = await input.client.completeJson<{ scenarios?: unknown }>({
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `生成 ${input.count} 个场景。\n` +
          `可选门板：${input.doorStyleIds.join("、")}\n` +
          `可选五金：${input.hardwareIds.join("、") || "（无）"}\n` +
          `可选配件：${input.accessoryIds.join("、") || "（无）"}`,
      }],
      schemaHint: SCHEMA_HINT,
      callSite: "specTemplateParse",
    });
    const parsed = validate(raw?.scenarios, input);
    if (parsed.length > 0) {
      return {
        scenarios: parsed,
        source: "llm",
        note: `${parsed.length} 个场景由 LLM 生成（要求覆盖形状/尺寸边界/偏好组合/口语化表达）`,
      };
    }
  }

  const scenarios = deterministicScenarios(input);
  return {
    scenarios,
    source: "deterministic",
    note: "**未配置 LLM，场景来自确定性生成器**（固定种子，可复现）。" +
      "覆盖面按维度组合展开，但缺少 LLM 那种口语化表达的多样性。",
  };
}

/**
 * 校验 LLM 产出。
 *
 * 模型给的东西**一律不信**：尺寸越界、引用不存在的门板 id、特征超出墙长，
 * 都会让场景跑不起来或者跑出假的结论。逐条修正或丢弃，不静默接受。
 */
function validate(raw: unknown, input: GenerateInput): Scenario[] {
  if (!Array.isArray(raw)) return [];
  const out: Scenario[] = [];

  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;

    const walls = Array.isArray(s["walls"]) ? s["walls"] : [];
    const cleanWalls: ScenarioWall[] = [];
    for (const w of walls as Record<string, unknown>[]) {
      const length = quantize(clamp(Number(w?.["length"]), 30, 240));
      if (!Number.isFinite(length)) continue;
      const features = (Array.isArray(w?.["features"]) ? w["features"] : [])
        .map((f) => f as Record<string, unknown>)
        .filter((f) => KINDS.has(String(f?.["kind"])))
        .map((f) => ({
          kind: String(f["kind"]) as ScenarioWall["features"][number]["kind"],
          offset: quantize(Math.max(0, Number(f["offset"]) || 0)),
          width: quantize(Math.max(0, Number(f["width"]) || 0)),
        }))
        // 超出墙长的特征直接丢——它会让 addFeature 端点 400
        .filter((f) => f.offset + f.width <= length);
      cleanWalls.push({ label: String(w?.["label"] ?? `墙 ${cleanWalls.length + 1}`), length, features });
    }
    if (cleanWalls.length === 0) continue;

    const prefs = (s["prefs"] ?? {}) as Record<string, unknown>;
    const turns = Array.isArray(s["turns"])
      ? (s["turns"] as unknown[]).map(String).filter((t) => t.trim()).slice(0, 8) : [];

    out.push({
      id: String(s["id"] ?? String.fromCharCode(65 + i)),
      name: String(s["name"] ?? `场景 ${i + 1}`),
      shape: String(s["shape"] ?? `${cleanWalls.length} 段墙`),
      covers: String(s["covers"] ?? "（未说明覆盖意图）"),
      accountType: s["accountType"] === "trade" ? "trade" : "consumer",
      turns: turns.length > 0 ? turns : ["想重做厨房橱柜"],
      ceilingHeight: quantize(clamp(Number(s["ceilingHeight"]) || 96, 84, 120)),
      walls: cleanWalls,
      prefs: {
        ...pick(prefs, "budgetBand", ["economy", "standard", "premium", "unsure"]),
        ...(input.doorStyleIds.includes(String(prefs["doorStyleId"]))
          ? { doorStyleId: String(prefs["doorStyleId"]) } : {}),
        ...pick(prefs, "storage", ["drawers", "doors", "balanced"]),
        ...pick(prefs, "assembly", ["RTA", "assembled"]),
        ...pick(prefs, "tradeoff", ["price", "quality", "lookAndFeel"]),
        hardwareOptionIds: idsIn(prefs["hardwareOptionIds"], input.hardwareIds),
        accessoryOptionIds: idsIn(prefs["accessoryOptionIds"], input.accessoryIds),
      },
      revisions: cleanRevisions(s["revisions"], input),
      customerFacts: attachCustomerFacts({
        turns: turns.length > 0 ? turns : ["想重做厨房橱柜"],
        walls: cleanWalls,
        ceilingHeight: quantize(clamp(Number(s["ceilingHeight"]) || 96, 84, 120)),
        prefs: {
          ...pick(prefs, "budgetBand", ["economy", "standard", "premium", "unsure"]),
        },
        shape: String(s["shape"] ?? ""),
        rawFacts: s["customerFacts"],
      }),
    } as Scenario);
  }
  return out;
}

/** 为场景补全仅供 user agent 的私有事实（FR-20）。 */
function attachCustomerFacts(input: {
  turns: string[];
  walls: ScenarioWall[];
  ceilingHeight: number;
  prefs: { budgetBand?: string };
  shape: string;
  rawFacts?: unknown;
}): CustomerFacts {
  if (input.rawFacts && typeof input.rawFacts === "object") {
    return input.rawFacts as CustomerFacts;
  }
  const budgetMap: Record<string, string> = {
    economy: "Budget under CAD $10k",
    standard: "Budget CAD $10–20k",
    premium: "Budget over CAD $20k",
    unsure: "Budget not decided yet",
  };
  const hasPlumb = input.walls.some((w) => w.features.some((f) => f.kind === "plumbing"));
  const hasWin = input.walls.some((w) => w.features.some((f) => f.kind === "window"));
  const plumbWall = input.walls.find((w) => w.features.some((f) => f.kind === "plumbing"));
  return {
    intent: input.turns[0] ?? "Want new kitchen cabinets",
    kitchenTalk: `${input.shape || "kitchen"}, roughly ` +
      input.walls.map((w) => `${w.label} ${Math.round(w.length / 12)} ft`).join(", "),
    walls: input.walls.map((w) => ({ label: w.label, length: w.length })),
    ceilingHeight: input.ceilingHeight,
    style: /质感|高级灰|modern|现代|北欧|farmhouse/i.test(input.turns.join("\n"))
      ? (input.turns.find((t) => /质感|高级灰|现代|风格|nordic|farmhouse|modern/i.test(t)) ?? "Modern")
      : "Modern",
    budget: input.prefs.budgetBand
      ? budgetMap[input.prefs.budgetBand]
      : "Budget CAD $10–20k",
    province: "Ontario ON",
    appliances: "Fridge and range; not sure about exact widths",
    plumbing: hasPlumb
      ? `Plumbing on ${plumbWall?.label ?? "the main wall"}, near the middle`
      : "Plumbing later",
    windows: hasWin ? "There is a window on one of the walls" : "No windows",
    mentionCompany: "枫岭橱柜",
  };
}

const KINDS = new Set(["window", "plumbing", "gas", "electrical", "door"]);

/**
 * 清洗修改轮次。
 *
 * `changes` 走和 `prefs` 一样的过滤——模型很容易在这里编一个不存在的门板 id，
 * 而服务端会 400，那时候看到的是"测试挂了"，不是"模型编了个 id"。
 */
const REVISION_INTENTS: readonly RevisionIntent[] = [
  "spice_near_cooktop", "trash_pullout", "more_drawers", "doors_over_drawers",
  "enlarge_island", "double_drawer", "sink_under_window", "swap_door_style",
  "unactionable",
];

function inferRevisionIntent(note: string, changes: Record<string, unknown>): RevisionIntent {
  if (/调料|spice|拉篮/i.test(note)) return "spice_near_cooktop";
  if (/垃圾桶|trash/i.test(note)) return "trash_pullout";
  if (/岛台.*大|enlarge.*island|岛台做大/i.test(note)) return "enlarge_island";
  if (/双抽|double.?drawer|#\d+.*抽/i.test(note)) return "double_drawer";
  if (/窗子下面|under.?window|sink base/i.test(note)) return "sink_under_window";
  if (/门板换|door.?style|换个样式/i.test(note)) return "swap_door_style";
  if (/大气|怪怪的|整体.*好看|looks? nicer/i.test(note)) return "unactionable";
  if (changes["storage"] === "drawers") return "more_drawers";
  if (changes["storage"] === "doors") return "doors_over_drawers";
  if (Object.keys(changes).length === 0) return "unactionable";
  return "more_drawers";
}

function cleanRevisions(raw: unknown, input: GenerateInput): ScenarioRevision[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const ch = (r["changes"] ?? {}) as Record<string, unknown>;
    const hw = idsIn(ch["hardwareOptionIds"], input.hardwareIds);
    const ac = idsIn(ch["accessoryOptionIds"], input.accessoryIds);
    const changes: Scenario["prefs"] = {
      ...pick(ch, "budgetBand", ["economy", "standard", "premium", "unsure"]),
      ...(input.doorStyleIds.includes(String(ch["doorStyleId"]))
        ? { doorStyleId: String(ch["doorStyleId"]) } : {}),
      ...pick(ch, "storage", ["drawers", "doors", "balanced"]),
      ...pick(ch, "assembly", ["RTA", "assembled"]),
      ...pick(ch, "tradeoff", ["price", "quality", "lookAndFeel"]),
      ...(hw.length ? { hardwareOptionIds: hw } : {}),
      ...(ac.length ? { accessoryOptionIds: ac } : {}),
    };
    const intentRaw = String(r["intent"] ?? "");
    const intent = (REVISION_INTENTS as readonly string[]).includes(intentRaw)
      ? intentRaw as RevisionIntent
      : inferRevisionIntent(String(r["note"] ?? ""), ch);
    // 丢弃含写死型号的 note——由模拟器见首版后再生成
    const rawNote = String(r["note"] ?? "").trim();
    const note =
      rawNote && !/\bB\d{2}\b|\b[A-Z]{2,}\d{2}[A-Z]*/i.test(rawNote)
        ? rawNote
        : undefined;
    return { intent, ...(note ? { note } : {}), changes };
  });
}

function pick<K extends string>(
  o: Record<string, unknown>, key: string, allowed: readonly K[],
): Record<string, K> {
  const v = String(o[key] ?? "");
  return (allowed as readonly string[]).includes(v) ? { [key]: v as K } as Record<string, K> : {};
}

function idsIn(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String).filter((id) => allowed.includes(id));
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function quantize(n: number): number {
  return Math.round(n * 4) / 4;
}

// ── 确定性回退 ────────────────────────────────────────────────────────────

/**
 * 按维度组合展开的场景。
 *
 * 这不是"随便造几个"——每个场景对应 SYSTEM 里列的一条覆盖要求，
 * 所以没有 LLM 时覆盖面依然成立，只是对话措辞是固定的。
 */
/**
 * 内置场景的条数。
 *
 * 模拟器的默认条数用它，不写死一个数字：**加了场景却忘了改默认值**，
 * 新场景就再也不会被跑到，而"跑通了"的报告看起来和真跑全了一模一样。
 */
export const BUILTIN_SCENARIO_COUNT = 9;

function deterministicScenarios(input: GenerateInput): Scenario[] {
  const doors = input.doorStyleIds;
  const d = (i: number) => doors[i % Math.max(1, doors.length)] ?? "";

  const base: Scenario[] = [
    {
      id: "A", name: "小公寓 · 一字型（尺寸下界）", shape: "一字型",
      covers: "单墙、很小的厨房（84 英寸），窗与上下水都靠边",
      accountType: "consumer",
      turns: ["公寓厨房很小，想换橱柜", "就一面墙，七尺不到", "白色的就行，别太贵"],
      ceilingHeight: 96,
      walls: [{
        label: "北墙", length: 84,
        features: [
          { kind: "window", offset: 30, width: 24 },
          { kind: "plumbing", offset: 36, width: 24 },
        ],
      }],
      prefs: { budgetBand: "economy", doorStyleId: d(0), storage: "doors", assembly: "RTA", tradeoff: "price" },
      // 故意偏大：84" 墙 + 水槽区装不下 36"+30" —— 期望 early-fit 拦住，不得出图报价
      appliances: [
        { kind: "refrigerator", width: 36 },
        { kind: "range", width: 30 },
      ],
      revisions: [
        {
          intent: "sink_under_window",
          note: "sink base要放在窗子下面",
          changes: { layoutHints: { includeSpicePullout: false } },
        },
        // note / #N 由模拟器见首版 cabinetIndex 后生成——禁止写死 B12
        { intent: "spice_near_cooktop" },
      ],
      customerFacts: {
        intent: "小公寓换橱柜，想在灶台旁加调料拉篮",
        kitchenTalk: "一字型，北墙大约七尺",
        style: "白色简约",
        budget: "Budget under CAD $10k",
        province: "Ontario ON",
        appliances: "Fridge 36\", range 30\"",
        notes: "prefer spice pullout near cooktop; expect early space check",
      },
    },
    {
      id: "B", name: "独立屋 · L 型 · 高层高", shape: "L 型",
      covers: "两段墙、内墙角让位、108 英寸层高（吊柜档位不同）、多轮改排布、口语化的风格描述",
      accountType: "consumer",
      turns: [
        "我们家厨房要整个翻新",
        "L 型的，长边十三尺左右，短边八尺多",
        "想要质感好一点的，高级灰那种感觉",  // 刻意用关键词表里没有的说法
        "锅具多，希望抽屉多一些",
      ],
      ceilingHeight: 108,
      walls: [
        {
          label: "北墙", length: 156,
          features: [
            { kind: "window", offset: 66, width: 36 },
            { kind: "plumbing", offset: 72, width: 24 },
          ],
        },
        // 燃气位 54"：内墙角那一头有 27" 归北墙的柜子（相邻段进深 + 转角填缝条），
        // 燃气再往墙角靠的话，灶具左侧就留不出放热锅的落台区——这不是凑数字，
        // 是把「墙角要让位」这件事算进了户型本身
        { label: "东墙", length: 102, features: [{ kind: "gas", offset: 54, width: 30 }] },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(1), storage: "drawers", assembly: "RTA",
        hardwareOptionIds: input.hardwareIds.slice(0, 1),
        accessoryOptionIds: input.accessoryIds.slice(0, 1),
        tradeoff: "quality",
      },
      revisions: [
        {
          intent: "doors_over_drawers",
          note: "抽屉做这么多有点贵，还是多用门板柜吧",
          changes: { storage: "doors" },
        },
        { intent: "trash_pullout" },
        { intent: "unactionable", note: "整体看着大气一点就好", changes: {} },
      ],
    },
    {
      id: "C", name: "建商项目 · U 型 · 组装好发货", shape: "U 型",
      covers: "三段墙、两个内墙角（转角柜 + 让位）、trade 账号（未核实→按零售价）、assembled（吊柜不提供）、premium 档",
      accountType: "trade",
      turns: [
        "装修公司，手上一个改造项目",
        "U 型，三面墙都是 11 尺",
        "业主要深色门板，五金要好的",
        "柜子要组装好送过来，工期紧",
      ],
      ceilingHeight: 96,
      walls: [
        { label: "西墙", length: 132, features: [{ kind: "electrical", offset: 0, width: 36 }] },
        {
          // U 型的三面墙一样长。中间这面两头各有一个内墙角，各让 27" 出去，
          // 剩 78" 才够摆「水槽 + 两侧工作台面」（36 + 24 + 18）。
          // 原来这里写的是 108"，让位算进去后只剩 54"——排出来的方案会被
          // 系统自己的 NKBA 检查判为不合格，那是户型本身的问题，不是排布的问题。
          label: "北墙", length: 132,
          features: [
            { kind: "window", offset: 48, width: 36 },
            { kind: "plumbing", offset: 54, width: 24 },
          ],
        },
        { label: "东墙", length: 132, features: [{ kind: "gas", offset: 54, width: 30 }] },
      ],
      prefs: {
        budgetBand: "premium", doorStyleId: d(3), storage: "balanced", assembly: "assembled",
        hardwareOptionIds: [...input.hardwareIds],
        tradeoff: "lookAndFeel",
      },
      revisions: [
        {
          intent: "more_drawers",
          note: "业主说锅具多，灶台附近都换成抽屉",
          changes: { storage: "drawers", budgetBand: "standard" },
        },
        // #N 见首版后再填
        { intent: "double_drawer" },
      ],
    },
    {
      id: "D", name: "大开间 · 一字型（尺寸上界）+ 门洞", shape: "一字型",
      covers: "很长的单墙（216 英寸）、墙上有门洞、没有窗（不能编一个不存在的参照物）",
      accountType: "consumer",
      turns: ["老房子改造，厨房是个长条", "一面墙十八尺，中间有个门通餐厅", "预算还没想好"],
      ceilingHeight: 96,
      walls: [{
        label: "南墙", length: 216,
        features: [
          { kind: "door", offset: 96, width: 32 },
          { kind: "plumbing", offset: 30, width: 24 },
        ],
      }],
      prefs: { budgetBand: "unsure", doorStyleId: d(2), storage: "balanced", assembly: "RTA" },
      revisions: [
        {
          intent: "swap_door_style",
          note: "门板换个样式看看",
          changes: { doorStyleId: d(1) },
        },
        {
          intent: "more_drawers",
          note: "锅碗瓢盆多，抽屉柜能不能多排一些",
          changes: { storage: "drawers" },
        },
        { intent: "unactionable", note: "这个位置我总觉得怪怪的", changes: {} },
      ],
    },
    {
      id: "E", name: "开放式厨房 · L 型 + 岛台", shape: "L 型 + 岛台",
      covers: "岛台：不靠墙的一列柜子、四周过道净空（NKBA 42\"）、岛台不生成吊柜层",
      accountType: "consumer",
      turns: [
        "开放式厨房，中间想加个岛台",
        "L 型，长边十四尺，短边十尺，岛台想做七尺",
        "岛台那边平时也当早餐台用",
      ],
      ceilingHeight: 96,
      walls: [
        {
          label: "北墙", length: 168,
          features: [
            { kind: "window", offset: 72, width: 36 },
            { kind: "plumbing", offset: 78, width: 24 },
          ],
        },
        { label: "西墙", length: 120, features: [{ kind: "gas", offset: 60, width: 30 }] },
        // 岛台：84" 长、25" 深（单排柜 + 背板收口）。它和两面墙之间的过道
        // 要 ≥42"，摆不下的话排布器会阻断——这正是「把墙连起来才看得见」的那类问题
        { label: "岛台", length: 84, depth: 25, kind: "island", features: [] },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(0), storage: "balanced", assembly: "RTA",
        tradeoff: "lookAndFeel",
      },
      revisions: [
        {
          intent: "more_drawers",
          note: "岛台这边多做点抽屉",
          changes: { storage: "drawers" },
        },
        { intent: "enlarge_island" },
      ],
    },
    {
      id: "F", name: "复式住宅 · 超高层高 + 点名第三家", shape: "L 型",
      covers: "120\" 层高（吊柜一定要叠装）、@ 点名走公司 Agent（系统里最大的一个 prompt）、"
        + "第三家试点的分体做法与 39\" 吊柜上限",
      accountType: "consumer",
      turns: [
        "复式的厨房，层高比较高",
        "L 型，长边十四尺，短边九尺，层高十尺",
        // @ 点名：既验证确定性路由，也让 token 分析覆盖到公司 Agent 那一路——
        // 它的 prompt 里注入了整份规格清单，是全系统最大的一个
        "@白桦橱柜 你们家吊柜最高做到多少？层高十尺的话上面怎么收口",
        "现代简约，预算两万以内，安大略省",
      ],
      ceilingHeight: 120,
      walls: [
        {
          label: "北墙", length: 168,
          features: [
            { kind: "window", offset: 72, width: 36 },
            { kind: "plumbing", offset: 78, width: 24 },
          ],
        },
        { label: "东墙", length: 108, features: [{ kind: "gas", offset: 54, width: 30 }] },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(0), storage: "balanced", assembly: "RTA",
        tradeoff: "quality",
      },
      revisions: [
        { intent: "unactionable", note: "上面那一截看着空，能做满吗", changes: {} },
      ],
    },
    {
      id: "G", name: "小户型 · 门洞紧贴墙角", shape: "L 型",
      covers: "门洞离内墙角很近——墙角让位 27\" 与门洞台面外伸 2-1/2\" 叠在一起，"
        + "是几何上最紧的一种组合（SR-G4 + SR-G5）",
      accountType: "consumer",
      turns: [
        "老公寓厨房，进门就是灶台",
        "L 型，长边十二尺，短边七尺半，进门的门洞紧挨着墙角",
        "北欧风，预算一万以内，BC 省",
      ],
      ceilingHeight: 96,
      walls: [
        {
          label: "西墙", length: 144,
          features: [
            { kind: "window", offset: 66, width: 30 },
            { kind: "plumbing", offset: 72, width: 24 },
          ],
        },
        {
          // 门洞从 30" 起——墙角已经让掉 27"，门洞的台面净空再吃 2-1/2"，
          // 两者之间只剩 1/2"。这是排布器最容易排出"看着没超墙、实际装不上"的地方
          label: "南墙", length: 90,
          features: [{ kind: "door", offset: 30, width: 32 }],
        },
      ],
      prefs: {
        budgetBand: "economy", doorStyleId: d(1), storage: "doors", assembly: "RTA",
        tradeoff: "price",
      },
      revisions: [],
    },
    {
      id: "H", name: "家电驱动的排布 · 尺寸有已知有不确定", shape: "L 型",
      covers: "场景 J：客户声明家电（冰箱 33\"、灶台 30\"、烟机、洗碗机、"
        + "烤箱「不确定」）→ 留空按实际尺寸算、推定值如实披露、配套柜按能力标签查",
      accountType: "consumer",
      turns: [
        "厨房要重做，家电基本都定好了",
        "L 型，长边十五尺，短边十尺",
        "冰箱 33 寸，灶台 30 寸，有抽油烟机也有洗碗机",
        "烤箱还没挑好，尺寸不确定",
      ],
      ceilingHeight: 96,
      walls: [
        {
          label: "北墙", length: 180,
          features: [
            { kind: "window", offset: 78, width: 36 },
            { kind: "plumbing", offset: 84, width: 24 },
            { kind: "electrical", offset: 6, width: 36 },
          ],
        },
        { label: "东墙", length: 120, features: [{ kind: "gas", offset: 54, width: 30 }] },
      ],
      appliances: [
        // 尺寸已知：留空按 33 + 2×1"（通风）= 35"，不是写死的 36"
        { kind: "refrigerator", width: 33, preferredZone: "nearEntry" },
        { kind: "range", width: 30 },
        { kind: "rangeHood", width: 30 },
        { kind: "dishwasher", width: 24 },
        // 客户说"不确定"：走常见默认值，但要标成推定并在解释里写清楚
        { kind: "wallOven" },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(0), storage: "balanced", assembly: "RTA",
        tradeoff: "quality",
      },
      revisions: [
        { intent: "unactionable", note: "烤箱那边先按标准的来吧", changes: {} },
      ],
    },
    {
      id: "I", name: "真实户型图上传 · Floor Plan - 1",
      shape: "L 型",
      covers: "客户上传真实 PNG 户型图（test/sources），再确认墙长/上下水/窗；覆盖 FR-15 检查表 + 视觉输入链路",
      accountType: "consumer",
      sourceImage: "Floor Plan - 1.png",
      turns: [
        "I have a floor plan photo — can we design from that?",
        "Modern shaker look, budget around CAD $15–25k, Ontario",
      ],
      ceilingHeight: 96,
      // 与样例图常见抽取量级接近；上传后仍由客户确认，不猜
      walls: [
        {
          label: "North", length: 137,
          features: [
            { kind: "window", offset: 48, width: 36 },
            { kind: "plumbing", offset: 60, width: 24 },
          ],
        },
        {
          label: "West", length: 125,
          features: [{ kind: "gas", offset: 48, width: 30 }],
        },
      ],
      appliances: [
        { kind: "refrigerator", width: 36 },
        { kind: "range", width: 30 },
        { kind: "dishwasher", width: 24 },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(0), storage: "balanced", assembly: "RTA",
        tradeoff: "quality",
      },
      revisions: [
        {
          intent: "more_drawers",
          note: "More drawers near the range please",
          changes: { storage: "drawers" },
        },
      ],
      customerFacts: {
        intent: "Design from floor plan photo; more drawers near the range",
        kitchenTalk: "L-shaped kitchen from uploaded plan",
        style: "Modern shaker",
        budget: "Budget CAD $15–25k",
        province: "Ontario ON",
        appliances: "Fridge 36\", range 30\", dishwasher 24\"",
        notes: "preference intent: more_drawers near range — never hardcode B12",
      },
    },
  ];

  // 常量与实际条数对不上就当场喊出来——静默取小值等于悄悄少跑几个场景
  if (base.length !== BUILTIN_SCENARIO_COUNT) {
    throw new Error(
      `BUILTIN_SCENARIO_COUNT=${BUILTIN_SCENARIO_COUNT}，实际内置 ${base.length} 个场景，` +
      `请同步改常量，否则模拟器默认跑不全`);
  }
  return base.slice(0, Math.max(1, input.count)).map((s) => ({
    ...s,
    customerFacts: attachCustomerFacts({
      turns: s.turns,
      walls: s.walls,
      ceilingHeight: s.ceilingHeight,
      prefs: { budgetBand: s.prefs.budgetBand },
      shape: s.shape,
    }),
  }));
}
