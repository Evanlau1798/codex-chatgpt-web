# Temporary downstream mitigation

This is the published http-cache-semantics 4.2.0 index.js and BSD-2-Clause license,
with one early revalidation guard added for GHSA-ch52-4w7c-c8xp. The upstream
advisory currently has no released patched version. Version is deliberately not
misrepresented as an upstream fix.

The guard refuses reuse of non-storable or no-cache responses, shared
proxy-revalidate responses, and shared Set-Cookie responses without public or
immutable, before both max-stale and stale-while-revalidate paths. It preserves
ordinary expired-cache reuse and private-cache semantics. Regression tests must
exercise the actual resolved dependency as well as the vendored file.

Local file dependencies are not npm advisory lookup coverage. A clean package
audit is therefore not evidence this vendor copy is secure; the explicit
regressions and source review are the mitigation evidence. Replace this copy
with an upstream release once a verified fix is published.

Reference: https://github.com/advisories/GHSA-ch52-4w7c-c8xp
