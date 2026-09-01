import { mediaError } from "../../src/images/media-errors";
import type { MediaCredentialLease } from "../../src/images/media-credentials";
import type { MediaCredentialBinding } from "../../src/images/types";
import { sanitizeApiKeyValue } from "../../src/providers/api-keys";

function needsAuth(): never {
  throw mediaError({ code: "needs_auth", phase: "pre_dispatch", certainty: "definite" });
}

export function createStaticMediaCredentialLease(
  binding: MediaCredentialBinding,
  token: string,
): MediaCredentialLease {
  const bearer = sanitizeApiKeyValue(token);
  if (!bearer || binding.authSource !== "api_key") needsAuth();
  return {
    async resolve(candidate) {
      if (
        candidate.authSource !== "api_key"
        || candidate.slotRef !== binding.slotRef
        || candidate.identityDigest !== binding.identityDigest
      ) needsAuth();
      return { bearer };
    },
    async refreshAfterRejectedOAuth() {
      return needsAuth();
    },
  };
}
