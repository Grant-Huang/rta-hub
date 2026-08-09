/**
 * 会话开场用的示例图目录 —— 户型简图 / 设计草图。
 *
 * 只允许白名单文件名，避免任意路径读取。
 */
export type SampleRole = "floorplan" | "design";

export interface IntakeSample {
  id: string;
  /** 磁盘文件名（位于 src/samples/）。 */
  file: string;
  role: SampleRole;
  labelEn: string;
  labelZh: string;
  hintEn: string;
  hintZh: string;
}

export const INTAKE_SAMPLES: readonly IntakeSample[] = [
  {
    id: "floorplan-minimal",
    file: "sample-floorplan-minimal.png",
    role: "floorplan",
    labelEn: "Floor-plan sketch example",
    labelZh: "户型手绘示例",
    hintEn:
      "No CAD? Sketch like this: wall lengths, window/sink/door with width + offset from a corner, island size, ceiling. Then upload with +.",
    hintZh:
      "没有正式图？可按此极简标注手绘：墙长、窗/水槽/门（宽度+距墙角偏移）、岛台尺寸、层高。画好后点 + 上传。",
  },
  {
    id: "design-sketch",
    file: "sample-design-sketch.jpg",
    role: "design",
    labelEn: "Design-idea sketch example",
    labelZh: "设计想法草图示例",
    hintEn:
      "Optional: if you already have a rough layout idea (fridge / sink / cooktop / seating), sketch it like this and upload — we treat it as intent, not hard geometry.",
    hintZh:
      "可选：若已有初步布置想法（冰箱/水槽/灶台/座位），可参照此图手绘后上传——作为意图参考，不覆盖已确认的墙长。",
  },
] as const;

const ALLOWED = new Set(INTAKE_SAMPLES.map((s) => s.file));

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
