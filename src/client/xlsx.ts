// Reads Excel (.xlsx) files in the browser: unzips them with the built-in
// DecompressionStream and turns each sheet into rows of text, like a CSV file.
// Dates come out as ISO dates, percentages with a % sign, everything else as shown.

type Entry = { name: string; method: number; offset: number; size: number };

function zipEntries(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This isn't an Excel (.xlsx) file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("The Excel file is damaged.");
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Data starts after the local header, whose name and extra lengths can differ from the central ones.
    const offset = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, method, offset, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(buf: Uint8Array, e: Entry): Promise<string> {
  const raw = buf.subarray(e.offset, e.offset + e.size);
  if (e.method === 0) return new TextDecoder().decode(raw);
  if (e.method !== 8) throw new Error("This Excel file uses a compression this browser can't read.");
  const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const byTag = (node: Document | Element, tag: string) => Array.from(node.getElementsByTagNameNS("*", tag));

/** Which number formats are dates (built-in ids and custom codes with d, m, y or h outside quotes). */
function dateStyles(stylesXml: string | null): { dates: Set<number>; percents: Set<number> } {
  const dates = new Set<number>(), percents = new Set<number>();
  if (!stylesXml) return { dates, percents };
  const doc = xml(stylesXml);
  const custom = new Map<number, string>();
  for (const f of byTag(doc, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? "");
  const cellXfs = byTag(doc, "cellXfs")[0];
  const xfs = cellXfs ? Array.from(cellXfs.children).filter((x) => x.localName === "xf") : [];
  xfs.forEach((xf, i) => {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dmyh]/i.test(code)) dates.add(i);
    if (id === 9 || id === 10 || code.includes("%")) percents.add(i);
  });
  return { dates, percents };
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function serialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

export type Sheet = { name: string; rows: string[][] };

export async function readXlsx(file: File, maxRows = 50_000): Promise<Sheet[]> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't open Excel files. Save the sheet as CSV instead.");
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = new Map(zipEntries(buf).map((e) => [e.name, e]));
  const read = async (name: string) => { const e = entries.get(name); return e ? readEntry(buf, e) : null; };
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("This isn't an Excel (.xlsx) file.");
  const wb = xml(workbook);
  const date1904 = byTag(wb, "workbookPr")[0]?.getAttribute("date1904") === "1" || byTag(wb, "workbookPr")[0]?.getAttribute("date1904") === "true";
  const rels = xml((await read("xl/_rels/workbook.xml.rels")) ?? "<Relationships/>");
  const target = new Map(byTag(rels, "Relationship").map((r) => [r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? ""]));
  const shared: string[] = [];
  const ss = await read("xl/sharedStrings.xml");
  if (ss) for (const si of byTag(xml(ss), "si")) shared.push(byTag(si, "t").map((t) => t.textContent ?? "").join(""));
  const { dates, percents } = dateStyles(await read("xl/styles.xml"));

  const sheets: Sheet[] = [];
  for (const s of byTag(wb, "sheet")) {
    const rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? s.getAttribute("r:id") ?? "";
    let path = target.get(rid) ?? "";
    path = path.startsWith("/") ? path.slice(1) : `xl/${path}`;
    const text = await read(path);
    if (!text) continue;
    const rows: string[][] = [];
    for (const row of byTag(xml(text), "row")) {
      if (rows.length > maxRows) break;
      const r = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
      const cells: string[] = [];
      for (const c of Array.from(row.children).filter((x) => x.localName === "c")) {
        const ref = c.getAttribute("r");
        const i = ref ? colIndex(ref) : cells.length;
        const t = c.getAttribute("t");
        const style = Number(c.getAttribute("s") ?? -1);
        const v = byTag(c, "v")[0]?.textContent ?? "";
        let out: string;
        if (t === "s") out = shared[Number(v)] ?? "";
        else if (t === "inlineStr") out = byTag(c, "t").map((x) => x.textContent ?? "").join("");
        else if (t === "b") out = v === "1" ? "true" : "false";
        else if (t === "str" || t === "e") out = v;
        else if (v !== "" && dates.has(style)) out = serialToIso(Number(v), date1904);
        else if (v !== "" && percents.has(style)) out = `${+(Number(v) * 100).toFixed(8)}%`;
        else out = v;
        while (cells.length < i) cells.push("");
        cells[i] = out;
      }
      while (rows.length < r) rows.push([]);
      rows[r] = cells;
    }
    // Blank rows (gaps in the sheet) aren't records.
    sheets.push({ name: s.getAttribute("name") ?? `Sheet ${sheets.length + 1}`, rows: rows.filter((r) => r && r.some((x) => x !== "")) });
  }
  if (!sheets.length) throw new Error("That Excel file has no sheets.");
  return sheets;
}
