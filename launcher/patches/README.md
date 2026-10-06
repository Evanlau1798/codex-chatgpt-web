# Temporary downloader cache mitigation

`http-cache-semantics@4.3.0.patch` adds one early revalidation guard to the
registry 4.3.0 artifact. It prevents request `max-stale` and stale-while-revalidate
from overriding non-storable/no-cache responses, shared proxy-revalidation, or
shared cookies without public/immutable opt-in. Ordinary expiry and private
cookie caching retain their existing behavior.

Upstream tracking: [fork issue #93](https://github.com/Evanlau1798/codex-chatgpt-web/issues/93)
and [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
The unpatched registry artifact reproduced ten protected-cache failures after
a clean frozen install. Its source SHA-256 is
`ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca`;
the reviewed patched source is
`d2fab3018e8b95d228548a26e0a061e38716fb1d43fc97b87524d330551e78b2`.

This is a downstream mitigation, not an upstream security release. A clean
package audit does not establish the mitigation's correctness. The launcher
regressions exercise the dependency actually resolved by `cacheable-request`,
including restored policies and positive controls. Remove the patch only when
a reviewed upstream release passes those cases without it. Keep the published
registry package and lock integrity; do not replace it with the old vendor copy.
