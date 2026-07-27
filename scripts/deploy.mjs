// Deploy the built app to the network configured in networks.json.
//
// Single source of truth: `active` picks the `pad`/dotns --env, `domain` picks
// the .dot name. Card metadata (name/description/icon) comes from
// polkadot-app-deploy.config.ts, which pad discovers automatically.
//
// Headless by default (uploads via the pre-authorized pool). Set MNEMONIC to
// sign + own the name with your own account; pad reads it from the env. Extra
// args are forwarded to pad, e.g. `npm run deploy:dot -- --publish`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(
    readFileSync(new URL("../networks.json", import.meta.url), "utf8"),
);
const env = cfg.active;
const domain = cfg.domain;
if (!env || !domain) {
    throw new Error("networks.json must define `active` and `domain`.");
}

const args = ["./dist", `${domain}.dot`, "--env", env, ...process.argv.slice(2)];
console.log(`\n▶ pad ${args.join(" ")}\n`);
execFileSync("pad", args, { stdio: "inherit" });
