# dotpages

> Build a website by tapping on it, then deploy it to IPFS and a `.dot` name in about a minute — no backend, no build step, no hosting account.

dotpages is a single-page WYSIWYG site builder that runs entirely in your browser. You edit blocks (headings, text, buttons, images) directly on the page, watch the exact bytes that will be deployed, and publish to the [Polkadot Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) (served over IPFS) with a DotNS `.dot` name pointing at it. It's built to run inside Polkadot Desktop / Polkadot Mobile as a hosted app, and falls back to browser wallets when standalone.

<!-- TODO: hero screenshot — the editor with the Profile template open, action bar visible (assets/screenshots/editor.png, ~700px wide) -->

## Features

- **Tap-to-edit blocks** — headings, paragraphs, links, pill buttons, images, and dividers, edited in place with per-block style toggles
- **An eject ladder, not a lock-in** — convert blocks → Markdown → raw HTML/CSS/JS (CodePen-style panes) when you outgrow the simple editor; climb back up anytime
- **What you preview is what you deploy** — the preview renders the byte-for-byte artifact that goes on chain
- **One-tap deploy** — stores your site on Bulletin Chain, registers a `.dot` name (auto-derived from your page title if you don't pick one), and points the name at your content
- **Pre-flight checklist** — before you spend a transaction, the app verifies size caps, storage authorization, name availability and price, funds, and account setup with free dry-runs; failures explain themselves and link to faucets
- **Instant redeploys** — names you already own skip registration entirely and just repoint, in seconds
- **Image uploads, optimized** — photos are downscaled and re-encoded client-side, stored on Bulletin, and referenced by IPFS URL
- **Host-first accounts** — uses your Polkadot Desktop/Mobile account automatically (fees sponsored by the host), with browser-extension and `//Bob` dev fallbacks

## Quick Start

<details>
<summary>Prerequisites</summary>

- Node.js 20+
- Network access on first install (`postinstall` runs `papi generate` against the live chains)

</details>

```bash
npm install
npm run dev
```

Open the printed localhost URL. For local development outside a host, tick **Use the //Bob dev account** in the Deploy panel — no wallet needed. To exercise the real host flow, open the deployed app inside Polkadot Desktop or Polkadot Mobile.

## Deploying a Site (in the app)

1. **Edit** — pick a template (Profile, Blog post, Event, or Blank) and tap anything to change it.
2. **Preview** — switch to the Preview tab to see the exact deployed page.
3. **Deploy** — open the Deploy tab:
   - The account chip shows who signs; the address underneath is copyable (you'll need it for faucets).
   - Leave the `.dot name` blank for an auto-derived name, or type your own — the checklist validates it live.
   - Wait for the pre-flight checks. Red ✕ items block nothing — the button arms a "Deploy anyway?" confirm — but they tell you what will fail and how to fix it.
4. Tap **Deploy**. A fresh name takes ~90 seconds (dominated by DotNS's mandatory 60s commit–reveal wait, during which your content uploads in parallel); updating a name you own takes a few seconds.
5. Your site is live at `https://<name>.dev-dot.li`, and the bytes are independently fetchable from the IPFS gateway by CID.

**Funding notes (devnet):**
- *Host accounts*: transaction fees are sponsored by the host, but the domain price (~0.1 PAS) and storage deposits come from the product account itself — send it PAS from the [Asset Hub faucet](https://faucet.polkadot.io/?parachain=1000) (the checklist links it).
- *Extension///Bob accounts*: also need Bulletin storage authorization from the [self-serve faucet](https://paritytech.github.io/polkadot-bulletin-chain/authorizations?tab=faucet), selecting the **Products Devnet** network. Host accounts skip this — the host submits storage on their behalf.

## Deploying the Builder Itself

The app deploys with [`pad`](https://www.npmjs.com/package/@polkadot-community-foundation/polkadot-app-deploy) (a devDependency, so `npm install` provides it) to the `.dot` name in `networks.json`:

```bash
npm run deploy:dot
```

That builds, then runs `pad ./dist <domain>.dot --env <active>` using `domain` and `active` from `networks.json` — so the app and its deploy target can never drift apart. Card metadata (name, description, icon) comes from `polkadot-app-deploy.config.ts`, which `pad` discovers automatically.

Uploads go through the pre-authorized pool by default. Set `MNEMONIC` to sign with — and own the name under — your own account. Extra arguments pass through to `pad`:

```bash
npm run deploy:dot -- --publish
```

## Configuration

| What | Where | Notes |
|------|-------|-------|
| Target network | `networks.json` → `active` | Endpoints, contracts, faucets, and gateway per network (`devnet`) |
| Deploy domain | `networks.json` → `domain` | The app's own `.dot` name; shared by the runtime config and `pad` |
| Product identifier | `VITE_PRODUCT_ACCOUNT_ID` env var | Overrides the hostname-derived identifier the host scopes accounts to |
| Chain descriptors | `npx papi generate` | Re-run when the target runtime upgrades |

## How It Works

The editor holds your site as a small block model. Rendering it (`renderHtml`) produces a complete, self-contained HTML document — that string is simultaneously the live preview and the deploy artifact. Deploying stores those bytes on Bulletin Chain (host-mediated preimage or a signed `TransactionStorage.store`), then drives the DotNS registrar contracts on Asset Hub through pallet-revive to register your name and point its contenthash at the CID.

For the full picture — account sources, the commit–reveal pipeline, why the host signer works the way it does, chain semantics the hard way — see [ARCHITECTURE.md](ARCHITECTURE.md).
