// In-host link handling. In a plain browser, links navigate normally (a new
// tab). Inside a Polkadot host (Desktop/Mobile webview, dot.li web iframe), a
// plain new-tab link is dead — the host's webview doesn't wire window-opening
// — so we route through hostApi.navigateTo and the host's own browser handles
// the URL (a `.dot` resolves natively; a `.dot.li` gateway URL resolves too).
//
// Host detection uses this app's canonical isInHost() (src/lib/host/detect.ts —
// the one place that logic lives); navigateTo is the Product SDK's top-level
// wrapper, which calls truApi.system.navigateTo and unwraps the response.

import { useState, type AnchorHTMLAttributes } from "react";
import { navigateTo } from "@parity/product-sdk-host";
import { isInHost } from "./lib/host/detect.ts";

/** In-host navigation. Hand the host the FULL `https://name.dot.li` URL (the
 *  Android host can't resolve the bare `name.dot` form via navigateTo).
 *
 *  The click was already preventDefault()ed, so every failure path has to lead
 *  somewhere. window.open is tried first — it works in the dot.li web iframe —
 *  but a Desktop/Mobile webview doesn't wire window-opening and returns null,
 *  which used to be the end of the line: a console warning the user can't see
 *  and a tap that does nothing. `onDeadEnd` is the last resort so the caller
 *  can put the URL somewhere the user can actually reach it. */
async function openInHost(url: string, onDeadEnd: () => void): Promise<void> {
    try {
        const result = await navigateTo(url);
        if (result.ok) return;
        console.warn("[dotpages] navigateTo failed", result.error);
    } catch (error) {
        console.warn("[dotpages] navigateTo threw", error);
    }
    try {
        if (window.open(url, "_blank", "noopener")) return;
    } catch {
        // Webview with window-opening disabled — fall through.
    }
    onDeadEnd();
}

/** The form of a link worth COPYING in the current environment. Inside a host,
 *  the user's browser resolves `.dot` natively, so hand it the bare `.dot`
 *  form instead of a `.dot.li` gateway detour. Outside a host (or for non-dot
 *  links), the URL passes through unchanged. */
export function hostLinkForm(url: string): string {
    if (!isInHost()) return url;
    try {
        const u = new URL(url);
        if (u.hostname.endsWith(".dot.li") || u.hostname.endsWith(".dot")) {
            const host = u.hostname.replace(/\.dot\.li$/, ".dot");
            const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
            return host + rest;
        }
    } catch {
        // not a parseable URL — copy as-is
    }
    return url;
}

/** Drop-in replacement for external `<a target="_blank">` links: opens in-host
 *  when running inside a Polkadot host, plain new-tab navigation otherwise. */
export function PopupLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const { href, onClick, children, ...rest } = props;
    // Set when the host refuses to navigate AND the webview blocks window.open.
    // The URL goes to the clipboard and the label says so, so a link the host
    // won't open is still followable by hand instead of silently doing nothing.
    const [copiedFallback, setCopiedFallback] = useState(false);
    return (
        <a
            {...rest}
            href={href}
            target="_blank"
            rel="noopener"
            onClick={(e) => {
                onClick?.(e);
                if (!href || !isInHost()) return;
                e.preventDefault();
                void openInHost(href, () => {
                    navigator.clipboard?.writeText(href).catch(() => {});
                    setCopiedFallback(true);
                    setTimeout(() => setCopiedFallback(false), 2400);
                });
            }}
        >
            {copiedFallback ? "link copied — paste in your browser" : children}
        </a>
    );
}
