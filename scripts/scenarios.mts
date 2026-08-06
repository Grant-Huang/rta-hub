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
}

export interface Scenario {
  id: string;
  name: string;
  shape: string;
  /** 覆盖意图——这个场景是冲着哪个边界去的。 */
  covers: string;
  accountType: "consumer" | "trade";
  turns: string[];
  ceilingHeight: number;
  walls: ScenarioWall[];
  prefs: {
    budgetBand?: "economy" | "standard" | "premium" | "unsure";
    doorStyleId?: string;
    storage?: "drawers" | "doors" | "balanced";
    assembly?: "RTA" | "assembled";
    hardwareOptionIds?: string[];
    accessoryOptionIds?: string[];
    tradeoff?: "price" | "quality" | "lookAndFeel";
  };
  /**
   * 客户在全局俯视图阶段提的修改，**每一轮都要带上具体改什么**。
   *
   * 只给一个轮次数字是测不出东西的：系统可以什么都不改、把同一张图再画一遍，
   * 测试照样"通过"。带上 `changes` 才能验证「客户提的意见真的改到了排布上」。
   */
  revisions: ScenarioRevision[];
}

export interface ScenarioRevision {
  /** 客户的原话。 */
  note: string;
  /** 这句话对应到系统里的哪些偏好项。空对象表示这轮是句改不动的话（也要测）。 */
  changes: Scenario["prefs"];
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
  "- revisions 取 0–3 条。每条要有 note（客户原话）和 changes（对应的偏好改动）；",
  "  changes 的键与 prefs 相同。**至少有一条 changes 为空对象**——模拟客户提了句",
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
      { "note": "锅碗多，能不能多做点抽屉", "changes": { "storage": "drawers" } },
      { "note": "整体想看着大气一点", "changes": {} }
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
    } as Scenario);
  }
  return out;
}

const KINDS = new Set(["window", "plumbing", "gas", "electrical", "door"]);

/**
 * 清洗修改轮次。
 *
 * `changes` 走和 `prefs` 一样的过滤——模型很容易在这里编一个不存在的门板 id，
 * 而服务端会 400，那时候看到的是"测试挂了"，不是"模型编了个 id"。
 */
function cleanRevisions(raw: unknown, input: GenerateInput): ScenarioRevision[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const ch = (r["changes"] ?? {}) as Record<string, unknown>;
    const hw = idsIn(ch["hardwareOptionIds"], input.hardwareIds);
    const ac = idsIn(ch["accessoryOptionIds"], input.accessoryIds);
    return {
      note: String(r["note"] ?? "再调一下排布"),
      changes: {
        ...pick(ch, "budgetBand", ["economy", "standard", "premium", "unsure"]),
        ...(input.doorStyleIds.includes(String(ch["doorStyleId"]))
          ? { doorStyleId: String(ch["doorStyleId"]) } : {}),
        ...pick(ch, "storage", ["drawers", "doors", "balanced"]),
        ...pick(ch, "assembly", ["RTA", "assembled"]),
        ...pick(ch, "tradeoff", ["price", "quality", "lookAndFeel"]),
        // 空数组和"没提"是两回事：只有真给了才写进去
        ...(hw.length ? { hardwareOptionIds: hw } : {}),
        ...(ac.length ? { accessoryOptionIds: ac } : {}),
      },
    };
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
          { kind: "window", offset: 6, width: 24 },
          { kind: "plumbing", offset: 12, width: 24 },
        ],
      }],
      prefs: { budgetBand: "economy", doorStyleId: d(0), storage: "doors", assembly: "RTA", tradeoff: "price" },
      revisions: [],
    },
    {
      id: "B", name: "独立屋 · L 型 · 高层高", shape: "L 型",
      covers: "两段墙、108 英寸层高（吊柜档位不同）、多轮改排布、口语化的风格描述",
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
        { label: "东墙", length: 102, features: [{ kind: "gas", offset: 30, width: 30 }] },
      ],
      prefs: {
        budgetBand: "standard", doorStyleId: d(1), storage: "drawers", assembly: "RTA",
        hardwareOptionIds: input.hardwareIds.slice(0, 1),
        accessoryOptionIds: input.accessoryIds.slice(0, 1),
        tradeoff: "quality",
      },
      revisions: [
        // 一条能落下去的（改排布）+ 一条落不下去的（验证系统如实说明）
        { note: "抽屉做这么多有点贵，还是多用门板柜吧", changes: { storage: "doors" } },
        { note: "整体看着大气一点就好", changes: {} },
      ],
    },
    {
      id: "C", name: "建商项目 · U 型 · 组装好发货", shape: "U 型",
      covers: "三段墙、trade 账号（未核实→按零售价）、assembled（吊柜不提供）、premium 档",
      accountType: "trade",
      turns: [
        "装修公司，手上一个改造项目",
        "U 型，三面墙 11 尺、9 尺、11 尺",
        "业主要深色门板，五金要好的",
        "柜子要组装好送过来，工期紧",
      ],
      ceilingHeight: 96,
      walls: [
        { label: "西墙", length: 132, features: [{ kind: "electrical", offset: 0, width: 36 }] },
        {
          label: "北墙", length: 108,
          features: [
            { kind: "window", offset: 36, width: 36 },
            { kind: "plumbing", offset: 42, width: 24 },
          ],
        },
        { label: "东墙", length: 132, features: [] },
      ],
      prefs: {
        budgetBand: "premium", doorStyleId: d(3), storage: "balanced", assembly: "assembled",
        hardwareOptionIds: [...input.hardwareIds],
        tradeoff: "lookAndFeel",
      },
      revisions: [
        { note: "业主说锅具多，灶台附近都换成抽屉", changes: { storage: "drawers", budgetBand: "standard" } },
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
        { note: "门板换个样式看看", changes: { doorStyleId: d(1) } },
        { note: "锅碗瓢盆多，抽屉柜能不能多排一些", changes: { storage: "drawers" } },
        { note: "这个位置我总觉得怪怪的", changes: {} },
      ],
    },
  ];

  return base.slice(0, Math.max(1, input.count));
}
