import type { EmailMessage, EmailMessageBuilder, SendEmail } from "@cloudflare/workers-types";
import { afterEach, expect, it, vi } from "vitest";
import { createEmailSender } from "./email.js";

const email = {
  to: "delivery@example.test",
  subject: "Synthetic delivery",
  text: "Synthetic verification capability",
  html: "<p>Synthetic verification capability</p>",
};

afterEach(() => {
  vi.useRealTimers();
});

it("recovers temporary mail refusals without changing the rendered message", async () => {
  vi.useFakeTimers();
  const submissions: Array<EmailMessage | EmailMessageBuilder> = [];
  const binding: SendEmail = {
    send(message) {
      submissions.push(message);
      const code = ["E_RATE_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR"][submissions.length - 1];
      if (code)
        return Promise.reject(Object.assign(new Error("Synthetic provider credential"), { code }));
      return Promise.resolve({ messageId: "synthetic-message" });
    },
  };
  const delivery = expect(
    createEmailSender(binding, "noreply@example.test")(email),
  ).resolves.toBeUndefined();
  await vi.runAllTimersAsync();
  await delivery;
  expect(submissions).toEqual(
    Array.from({ length: 3 }, () => ({ from: "noreply@example.test", ...email })),
  );
});

it.each(["E_SENDER_NOT_VERIFIED", "E_RECIPIENT_SUPPRESSED", "E_DAILY_LIMIT_EXCEEDED", undefined])(
  "does not retry a permanent or ambiguous failure (%s), and discards provider diagnostics",
  async (code) => {
    vi.useFakeTimers();
    let attempts = 0;
    const binding: SendEmail = {
      send() {
        attempts += 1;
        return Promise.reject(
          Object.assign(new Error("Synthetic provider credential and recipient"), { code }),
        );
      },
    };
    const delivery = expect(
      createEmailSender(binding, "noreply@example.test")(email),
    ).rejects.toThrow(/^Email sending failed\.$/);
    await vi.runAllTimersAsync();
    await delivery;
    expect(attempts).toBe(1);
  },
);

it("stops after three temporary failures and returns only a content-free error", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const binding: SendEmail = {
    send() {
      attempts += 1;
      return Promise.reject(
        Object.assign(new Error("Synthetic provider credential"), {
          code: "E_RATE_LIMIT_EXCEEDED",
        }),
      );
    },
  };
  const delivery = expect(
    createEmailSender(binding, "noreply@example.test")(email),
  ).rejects.toThrow(/^Email sending failed\.$/);
  await vi.runAllTimersAsync();
  await delivery;
  expect(attempts).toBe(3);
});
