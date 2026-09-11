import { createAppealTokenSigner } from "../../../../packages/api/src/appeal-token.js";

// Synthetic capability fixture only; this entrypoint is never deployed.
const signer = createAppealTokenSigner("native-appeal-test-secret-at-least-32-chars");
export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") return Response.json(await signer.verify(await request.text()));
    return new Response(
      await signer.sign({
        purpose: "appeal",
        actionId: "11111111-1111-4111-8111-111111111111",
        userId: "auteur-é🎮",
        nonce: "synthetic-nonce",
        iat: Math.floor(Date.now() / 1000),
      }),
    );
  },
};
