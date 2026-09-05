// The default React import is load-bearing under `tsx`: files outside
// `apps/server`'s `include` compile as classic JSX (`React.createElement`),
// so rendering without it throws `React is not defined` in dev/E2E while the
// `tsup` production bundle (automatic runtime) works fine. Referenced as
// `<React.Fragment>` (not a bare `Fragment` import) so the import counts as
// used under `noUnusedLocals` in the web typecheck, which sees these sources
// transitively via `@my-tuums/api`.
import React, { type ReactNode } from "react";
import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  render,
  Row,
  Section,
} from "react-email";
import { EmailCopy, type EmailAction } from "./rich-text.js";
import { MYTUUMS_EMAIL_THEME as theme } from "./theme.js";

export type { EmailAction };

/** Everything `renderBrandedEmail` needs: the locale copy plus its HTML-only dressing. */
export interface BrandedEmailInput {
  subject: string;
  text: string;
  locale: string;
  logoUrl: string;
  action?: EmailAction;
  otp?: string;
}

/**
 * Renders the HTML part of one multipart email through the owned
 * emailcn-style templates. Async because `react-email`'s `render` inlines
 * styles asynchronously; the plain-text part is untouched — the locale copy
 * in `../email.ts` stays the source of truth for both parts.
 */
export async function renderBrandedEmail(input: BrandedEmailInput): Promise<string> {
  return render(
    <MytuumsShell
      lang={input.locale}
      preview={input.subject}
      title={input.subject}
      logoUrl={input.logoUrl}
    >
      <EmailCopy text={input.text} action={input.action} otp={input.otp} />
    </MytuumsShell>,
  );
}

/**
 * One branded letter for every auth and moderation message: logo header,
 * title, copy, muted footer on a tinted background — light only, so the
 * palette never inverts under a dark-mode client.
 */
function MytuumsShell({
  lang,
  preview,
  title,
  logoUrl,
  children,
}: {
  lang: string;
  preview: string;
  title: string;
  logoUrl: string;
  children: ReactNode;
}): ReactNode {
  return (
    <React.Fragment>
      <Html lang={lang}>
        <Head>
          {/* No explicit <title>: `render` generates one from <Preview>, which
            carries the subject — a second title would only duplicate it. */}
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light" />
          <meta name="supported-color-schemes" content="light" />
        </Head>
        <Body
          style={{
            margin: "0",
            padding: "0",
            backgroundColor: theme.background,
            color: theme.text,
          }}
        >
          <Preview>{preview}</Preview>
          <Container
            style={{ width: "100%", maxWidth: "600px", margin: "0 auto", padding: "24px 12px" }}
          >
            <Section
              role="article"
              aria-label={title}
              style={{
                backgroundColor: theme.card,
                border: `1px solid ${theme.border}`,
                borderTop: `3px solid ${theme.primary}`,
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <Section
                style={{ padding: "20px 32px 16px", borderBottom: `1px solid ${theme.border}` }}
              >
                <Row>
                  <Column style={{ width: "44px", verticalAlign: "middle" }}>
                    <Img
                      src={logoUrl}
                      width="32"
                      height="32"
                      alt="MyTuums logo"
                      style={{
                        display: "block",
                        width: "32px",
                        height: "32px",
                        borderRadius: "7px",
                      }}
                    />
                  </Column>
                  <Column style={{ verticalAlign: "middle" }}>
                    <Heading
                      as="h2"
                      style={{
                        margin: "0",
                        color: theme.text,
                        fontFamily: theme.font,
                        fontSize: "17px",
                        fontWeight: 700,
                        letterSpacing: "-0.2px",
                      }}
                    >
                      MyTuums
                    </Heading>
                  </Column>
                </Row>
              </Section>
              <Section style={{ padding: "28px 32px 24px" }}>
                <Heading
                  as="h1"
                  id="email-title"
                  style={{
                    margin: "0 0 20px",
                    color: theme.text,
                    fontFamily: theme.font,
                    fontSize: "24px",
                    fontWeight: 700,
                    lineHeight: "1.25",
                  }}
                >
                  {title}
                </Heading>
                {children}
              </Section>
              <Section
                style={{ padding: "14px 32px 18px", borderTop: `1px solid ${theme.border}` }}
              >
                <Heading
                  as="h2"
                  style={{
                    margin: "0",
                    color: theme.muted,
                    fontFamily: theme.font,
                    fontSize: "12px",
                    fontWeight: 400,
                    lineHeight: "1.5",
                  }}
                >
                  MyTuums
                </Heading>
              </Section>
            </Section>
          </Container>
        </Body>
      </Html>
    </React.Fragment>
  );
}
