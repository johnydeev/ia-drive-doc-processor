import { PDFParse } from "pdf-parse";
import { readFileSync } from "fs";

async function main() {
  const path = process.argv[2];
  if (!path) { console.error("Falta el path del PDF"); process.exit(1); }
  const buf = readFileSync(path);
  const parser = new PDFParse({ data: buf });
  try {
    const parsed = await parser.getText();
    const text = (parsed.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
    console.log(`=== ${path} ===`);
    console.log(`chars: ${text.length}`);
    console.log("--------");
    console.log(text);
  } finally {
    await parser.destroy();
  }
}
main();
