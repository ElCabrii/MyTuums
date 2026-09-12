# Link fetcher context

This private Cloudflare Worker and Container own outbound HTTP for rich link
cards. The application owns caching, Open Graph parsing, image validation, R2
storage, moderation and authorization. The fetcher has no database, media, email
or authentication bindings and no public route, workers.dev or preview URL.

`worker/index.ts` exports the service-only `LinkFetchService` entrypoint and one
`LinkFetcherContainer`. The service accepts only small POST bodies for
`/lookup` and `/fetch`. Requests forwarded to Node contain only that body and its
content type, never browser cookies, authorization or Access headers.

`src/handler.ts` implements the protocol through the existing API address guard
and Node DNS/Undici transport. Each fetch is one manually followed HTTP hop.
Connect-time validation still checks every resolved address; TLS verifies the
original hostname. The bridge forwards only status, content type and Location.
It caps each response at 5 MiB, limits work to four concurrent operations, and
retains the five-second network deadline. The application's smaller HTML limit
and total redirect deadline still apply. Failure leaves the ordinary plain-link
fallback. Cold startup counts toward that application deadline.

Each environment has a separate `lite` Container that sleeps after 60 seconds
without requests. Default, preview and production Wrangler files name separate
Workers; the protected production candidate uses the production fetcher. This
keeps preview releases from changing production networking. The stable `links`
instance name must not change during a routine deployment. The service retains
no application data and never selects a database or bucket. Its image runs the bundled Node 24 fetcher as a non-root user. The new
Dockerfile belongs only to this Cloudflare helper; the Railway app image is not
restored.

`pnpm build` bundles Node and performs a Wrangler dry run, including the image
build. Docker must be running. `pnpm --filter @my-tuums/link-fetcher types` regenerates the Worker binding types.
Run `pnpm test:unit`, `pnpm lint` and `pnpm typecheck` in this workspace; the
boundary suite connects the Worker adapter to the actual handler and checks
redirect preservation, cookie isolation, private-address refusal and byte caps.
The API's existing link tests own the full guard and parser behavior. Hosted
validation must additionally exercise cold startup, valid and invalid TLS,
metadata and image downloads through the private service binding.

The CI-gated deployment command deploys this helper before each application
release. Application Worker configuration binds the named private entrypoint.
