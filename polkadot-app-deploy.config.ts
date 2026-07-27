// Product card metadata read by `pad` at deploy time (name, description, icon
// for Browse and the Polkadot app). The .dot domain comes from networks.json
// so it stays in one place — see scripts/deploy.mjs.
import { readFileSync } from "node:fs";

const { domain } = JSON.parse(
    readFileSync(new URL("./networks.json", import.meta.url), "utf8"),
);

export default {
    domain: `${domain}.dot`,
    displayName: "dotpages",
    description: "Tap-to-build websites, published to a .dot name — no backend, no build step.",
    icon: { path: "./icon.png", format: "png" },
    executables: [{ kind: "app", path: "./dist", appVersion: [1, 0, 0] }],
};
