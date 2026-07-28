import ExcelJS from "exceljs";
import { readFileSync } from "fs";
const b64 = readFileSync("/tmp/x.b64", "utf8").trim();
const buf = Buffer.from(b64, "base64");
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
console.log("SHEETS:", wb.worksheets.map(w=>w.name));
const ws = wb.worksheets[0];
for (let r=1; r<=14; r++) {
  const vals=[];
  for (let c=1;c<=8;c++){ const v = ws.getCell(r,c).value; vals.push(String(v==null?'':(typeof v==='object'&&v.result!=null?v.result:v)).replace(/\n/g,'|')); }
  console.log(`R${r}: ` + vals.join(" | "));
}
console.log("MERGES:", Object.keys(ws._merges || {}).slice(0,20).join(", "));
