// RFC-0002 host permissions — idempotent per session, one host prompt each
// at most. Callers request the narrowest tag for the operation at hand:
// ChainSubmit before host-mediated transaction submission, PreimageSubmit
// before host-mediated Bulletin preimage storage.
//
// requestPermission (from @parity/product-sdk-host) prompts over the
// desktop↔phone bridge, which can WEDGE and never settle. Each grant is
// deadline-bound so a dead bridge falls through to the best-effort catch
// instead of hanging — the sign/submit that follows is the real authority.

import { requestPermission } from "@parity/product-sdk-host";
import { SIGN_DEADLINE_MS, withDeadline } from "../deadline.ts";

type PermissionTag = "ChainSubmit" | "PreimageSubmit" | "StatementSubmit";

const granted = new Set<PermissionTag>();

export async function ensureHostPermission(tag: PermissionTag): Promise<void> {
    if (granted.has(tag)) return;
    try {
        // requestPermission reports on the `err` channel rather than throwing,
        // so BOTH halves have to be checked: `result.ok` is only "the host
        // answered", and `result.value` is the actual grant/deny. Testing the
        // Result object for truthiness would cache every denial as a grant.
        const result = await withDeadline(
            requestPermission({ tag, value: undefined }),
            SIGN_DEADLINE_MS,
            "Requesting host permission",
        );
        if (result.ok && result.value) granted.add(tag);
    } catch {
        // Host without RFC-0002 (or a wedged bridge) — the operation itself
        // will prompt or fail loud.
    }
}
