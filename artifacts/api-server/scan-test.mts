import { readFileSync, writeFileSync } from "node:fs";
import { openai } from "@workspace/integrations-openai-ai-server";
import { scanDocument } from "./src/lib/scanner";

const inPath = "/home/runner/workspace/attached_assets/DB12E962-CDB5-4AFD-B254-1614B63AF4D3_1780424926248.jpeg";
const buf = readFileSync(inPath);
const res = await scanDocument({
  buf,
  client: openai as never,
  model: "gpt-4o-mini",
});
const outPath = "/home/runner/workspace/.local/scan_after.jpg";
writeFileSync(outPath, res.buf);
console.log(
  JSON.stringify({ detected: res.detected, bytes: res.buf.length, usage: res.usage })
);
