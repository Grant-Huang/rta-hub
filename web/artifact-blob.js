/**
 * 产出物 source → 可写入 Blob 的数据。
 *
 * 户型图上传后登记的是 data URL（`data:image/png;base64,...`）。
 * 若直接 `new Blob([dataUrl])`，文件内容是这段文本，预览损坏、本地下载也打不开。
 * data URL 必须先解码成原始字节；SVG 源码等普通字符串原样返回。
 */
export function artifactSourceToBytes(source) {
  if (typeof source !== "string") return source;
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(source);
  if (!m) return source;
  const payload = m[3] ?? "";
  if (!m[2]) {
    try {
      return decodeURIComponent(payload);
    } catch {
      return payload;
    }
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
