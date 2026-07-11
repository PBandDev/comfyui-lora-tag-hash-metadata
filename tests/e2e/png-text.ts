import { readFileSync } from "node:fs";

export function readParametersText(pngPath: string): string {
  const buf = readFileSync(pngPath);
  let off = 8; // PNG signature
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (data.toString("latin1", 0, nul) === "parameters") {
        return data.toString("latin1", nul + 1);
      }
    }
    off += 12 + len;
  }
  throw new Error(`no tEXt parameters chunk in ${pngPath}`);
}
