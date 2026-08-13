/**
 * 会话开场用的示例图目录 —— 户型简图 / 设计草图。
 *
 * 只允许白名单文件名，避免任意路径读取。
 */
export type SampleRole = "floorplan" | "design";

export interface IntakeSample {
  id: string;
  /** 磁盘文件名（位于 src/samples/），原图——点开放大预览时用这个。 */
  file: string;
  /** 缩略图文件名（位于 src/samples/），卡片列表里用这个，体积是原图的百分之一量级。 */
  thumbFile: string;
  role: SampleRole;
  labelEn: string;
  labelZh: string;
  hintEn: string;
  hintZh: string;
}

/** `xxx.png` → `xxx.thumb.jpg`；缩略图统一转 jpg，体积比 png 小得多。 */
function thumbFileFor(file: string): string {
  return `${file.replace(/\.[^.]+$/, "")}.thumb.jpg`;
}

export const INTAKE_SAMPLES: readonly IntakeSample[] = [
  {
    id: "floorplan-minimal",
    file: "sample-floorplan-minimal.png",
    thumbFile: thumbFileFor("sample-floorplan-minimal.png"),
    role: "floorplan",
    labelEn: "Floor-plan sketch example",
    labelZh: "户型手绘示例",
    hintEn:
      "No CAD? Sketch like this: wall lengths, window/sink/door with width + offset from a corner, island size, ceiling. Then upload with +.",
    hintZh:
      "没有正式图？可按此极简标注手绘：墙长、窗/水槽/门（宽度+距墙角偏移）、岛台尺寸、层高。画好后点 + 上传。",
  },
  {
    id: "one-wall-kitchen",
    file: "one-wall-kitchen-floorplan.png",
    thumbFile: thumbFileFor("one-wall-kitchen-floorplan.png"),
    role: "floorplan",
    labelEn: "One-Wall Kitchen",
    labelZh: "单壁型厨房",
    hintEn:
      "Single straight wall layout (144\"). Common in small condos/apartments. Mark window, door, plumbing position.",
    hintZh:
      "单壁型布局（144英寸）。常见于小户型公寓。标注窗户、门、上下水位置。",
  },
  {
    id: "u-shaped-kitchen",
    file: "u-shaped-kitchen-floorplan.png",
    thumbFile: thumbFileFor("u-shaped-kitchen-floorplan.png"),
    role: "floorplan",
    labelEn: "U-Shaped Kitchen",
    labelZh: "U型厨房",
    hintEn:
      "Three-wall U-shape layout. Maximum counter space, ideal for 10x10' or larger. Mark door, window, sink position.",
    hintZh:
      "三面墙U型布局。台面空间最大化，适合10x10英尺以上。标注门、窗、水槽位置。",
  },
  {
    id: "l-island-kitchen",
    file: "l-island-kitchen-floorplan.png",
    thumbFile: thumbFileFor("l-island-kitchen-floorplan.png"),
    role: "floorplan",
    labelEn: "L-Shape + Island Kitchen",
    labelZh: "L型+岛台厨房",
    hintEn:
      "L-shaped walls with center island. Popular in modern homes. Mark island size (72x36\"), door, window, plumbing.",
    hintZh:
      "L型墙面+中央岛台。现代住宅流行布局。标注岛台尺寸（72x36英寸）、门、窗、上下水。",
  },
  {
    id: "galley-kitchen",
    file: "galley-kitchen-floorplan.png",
    thumbFile: thumbFileFor("galley-kitchen-floorplan.png"),
    role: "floorplan",
    labelEn: "Galley Kitchen (Corridor)",
    labelZh: "双排型厨房（走廊式）",
    hintEn:
      "Two parallel walls with 48\" aisle. Efficient for narrow spaces (townhouses). Mark both walls, door, window, sink.",
    hintZh:
      "两面平行墙，48英寸通道。适合窄长空间（联排别墅）。标注两侧墙、门、窗、水槽。",
  },
  {
    id: "design-sketch",
    file: "sample-design-sketch.jpg",
    thumbFile: thumbFileFor("sample-design-sketch.jpg"),
    role: "design",
    labelEn: "Design-idea sketch example",
    labelZh: "设计想法草图示例",
    hintEn:
      "Optional: if you already have a rough layout idea (fridge / sink / cooktop / seating), sketch it like this and upload — we treat it as intent, not hard geometry.",
    hintZh:
      "可选：若已有初步布置想法（冰箱/水槽/灶台/座位），可参照此图手绘后上传——作为意图参考，不覆盖已确认的墙长。",
  },
] as const;

const ALLOWED = new Set(INTAKE_SAMPLES.flatMap((s) => [s.file, s.thumbFile]));

/** 白名单校验；拒绝路径穿越。 */
export function isAllowedSampleFile(name: string): boolean {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return false;
  }
  return ALLOWED.has(name);
}

export function sampleByFile(name: string): IntakeSample | undefined {
  return INTAKE_SAMPLES.find((s) => s.file === name);
}
