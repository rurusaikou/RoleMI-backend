import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const mode = process.argv[2];
if (!new Set(["local", "production"]).has(mode)) {
  console.error("Usage: node scripts/run-product-analytics.mjs <local|production>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(resolve(root, "sql/product-analytics.sql"), "utf8");
const baseArgs = ["d1", "execute", "rolemi-metrics"];

if (mode === "production") baseArgs.push("--remote", "--env", "production");
else baseArgs.push("--local");

// --file uses D1's import endpoint. These read-only reports should use the normal
// query endpoint, which Wrangler selects when SQL is supplied with --command.
// Execute each top-level statement separately: sending the entire report as one
// command can exceed D1's compound SELECT limit even though each report is small.
const statements = sql.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(Boolean);

for (const [index, statement] of statements.entries()) {
  const reportName = statement.match(/^-- 报表名称：(.+)$/m)?.[1]?.trim();
  const heading = reportName ? `${index + 1}/${statements.length} ${reportName}` : `${index + 1}/${statements.length}`;
  console.log(`\n=== RoleMI 产品分析 ${heading} ===`);
  const result = spawnSync("wrangler", [...baseArgs, `--command=${statement};`], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Failed to start Wrangler: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
