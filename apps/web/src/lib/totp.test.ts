import { describe, expect, it } from "vitest";
import { formatTotpSecret, totpSecretFrom } from "@/lib/totp";

describe("totpSecretFrom", () => {
  it("reads the secret out of a real enrolment URI", () => {
    expect(
      totpSecretFrom(
        "otpauth://totp/MyTuums:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=MyTuums&algorithm=SHA1&digits=6&period=30",
      ),
    ).toBe("JBSWY3DPEHPK3PXP");
  });

  it("returns null when the URI carries no secret", () => {
    // The fallback is hidden rather than offering an empty key to type in.
    expect(totpSecretFrom("otpauth://totp/MyTuums:alice@example.com?issuer=MyTuums")).toBeNull();
  });

  it("returns null for a malformed URI instead of throwing", () => {
    // A crashed enrolment panel would be a far worse outcome than a missing
    // manual-entry fallback.
    expect(totpSecretFrom("not a uri at all")).toBeNull();
    expect(totpSecretFrom("")).toBeNull();
  });
});

describe("formatTotpSecret", () => {
  it("groups into blocks of four for readable manual entry", () => {
    expect(formatTotpSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });

  it("leaves a trailing partial block unpadded", () => {
    expect(formatTotpSecret("JBSWY3DPE")).toBe("JBSW Y3DP E");
  });

  it("leaves a short secret alone", () => {
    expect(formatTotpSecret("JBSW")).toBe("JBSW");
  });
});
