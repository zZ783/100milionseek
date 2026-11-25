import { readFileSync, writeFileSync } from "node:fs";

const path = "D:/Plug_In/100milionseek/package.json";
// Strip a UTF-8 BOM if an earlier PowerShell Set-Content left one behind.
const pkg = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const icon = readFileSync("D:/Plug_In/100milionseek/.icon-datauri.txt", "utf8").trim();

// Sanity check the existing zh is mojibake (contains typical GBK-as-UTF8 junk).
const badZh = /涓|锛|璐|垚|绔|閰|缁|浜/.test(pkg.magpie.summary.zh);
console.log("zh 当前是否乱码:", badZh);

pkg.version = "0.1.3";
pkg.magpie.icon = icon; // inline SVG data URI, no network needed
pkg.magpie.summary.zh = "100milionseek 上免费的 deepseek V4.1 Flash，每日额度直接读 API 的配额响应头";
pkg.magpie.summary.en =
  "Free deepseek V4.1 Flash on 100milionseek, with the daily token allowance read from the API's own quota headers";

writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("version:", pkg.version);
console.log("icon prefix:", pkg.magpie.icon.slice(0, 40), "... len", pkg.magpie.icon.length);
console.log("zh:", pkg.magpie.summary.zh, "| bytes:", Buffer.byteLength(pkg.magpie.summary.zh, "utf8"));
console.log("en bytes:", Buffer.byteLength(pkg.magpie.summary.en, "utf8"));
