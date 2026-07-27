// In-host link handling. In a plain browser, links navigate normally (a new
// tab). Inside a Polkadot host (Desktop/Mobile webview, dot.li web iframe), a
// plain new-tab link is dead — the host's webview doesn't wire window-opening
// — so we route through hostApi.navigateTo and the host's own browser handles
// the URL (a `.dot` resolves natively; a `.dot.li` gateway URL resolves too).
//
// Host detection uses this app's canonical isInHost() (src/lib/host/detect.ts —
// the one place that logic lives); navigateTo is the Product SDK's top-level
// wrapper, which calls truApi.system.navigateTo and unwraps the response.

import type { AnchorHTMLAttributes } from "react";
import { navigateTo } from "@parity/product-sdk-host";
import { isInHost } from "./lib/host/detect.ts";

/** In-host navigation. Hand the host the FULL `https://name.dot.li` URL (the
 *  Android host can't resolve the bare `name.dot` form via navigateTo). On
 *  failure the click was already preventDefault()ed, so fall back to a plain
 *  window.open rather than leave a dead tap. */
function openInHost(url: string): void {
    navigateTo(url)
        .then((result) => {
            if (!result.ok) {
                console.warn("[dotpages] navigateTo failed", result.error);
                // The click was preventDefault()ed, so an error would leave
                // a dead tap — fall back to plain navigation.
                window.open(url, "_blank", "noopener");
            }
        })
        .catch((error) => {
            console.warn("[dotpages] navigateTo failed", error);
            window.open(url, "_blank", "noopener");
        });
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
                openInHost(href);
            }}
        >
            {children}
        </a>
    );
}
