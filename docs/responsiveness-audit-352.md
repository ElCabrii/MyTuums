# Responsive layout investigation — issue 352

## Status and environment

Investigation on 2026-09-08 for [issue #352](https://github.com/ElCabrii/MyTuums/issues/352).
The original investigation below records the failing baseline. Application fixes and the requested profile improvements are now implemented locally; the implementation pass is recorded below. The coverage gaps remain, so this is not a complete device acceptance pass.

- Revision: release/0.5.0, `4c04d252a9529f0ad1aac99690e03b207d647982`, newer than the issue's source review.
- App: local Vite SPA at `http://localhost:5273`, local API at port 3101, dedicated `mytuums_issue352_test` database. No preview or production data was used.
- Browser: agent-browser driving Linux HeadlessChrome 152. Desktop browser with CSS viewport resizing; **not Safari, a physical phone, or a mobile virtual keyboard**.
- Baseline: English and French, light theme, 320 × 740, 768 × 1024, and 1440 × 900. Additional header widths: 360, 390, 430, 767/768/769, 1023/1024/1025, 1279/1280/1281, and 1920. Targeted dialogs: 740 × 320, 320 × 320, and 568 × 240.
- Sources of truth: registered files under `apps/web/src/routes`, application-owned components, rendered accessibility trees and DOM geometry. Generator-owned `components/ui` was inspected only.
- `apps/branding` was **not tested**.

The [route measurements](artifacts/responsiveness-352/route-measurements.json) retain 159 completed samples, including requested URL, resulting URL, locale, viewport and document width. Three incomplete samples were excluded and the long-profile route was rerun successfully. Some browser commands stalled; the task-specific browser was restarted. A network-idle or document-width result alone is not proof that every action is usable. Expected missing-resource states were visited; no JavaScript errors were returned by the browser error checks on the completed sessions.

## Agreed navigation direction

The user selected this direction during the investigation; it is now implemented:

- Mobile bottom navigation: Home, Discover, Games, Profile, with icons, labels and an active state.
- Mobile header: logo image without the MyTuums wordmark, linked to Home with an accessible name and sufficient touch area. Keep the wordmark at wider widths.
- Header actions: notification bell and a compact moderation shield for authorized roles. Add messages when private messaging works.
- Move theme access into the profile menu to free header space. Preserve a reachable sign-out action.
- Provide mobile global search on Discover and Search, below the header icon row.
- Account for the bottom safe area and reserve page space below the fixed bar.

## Confirmed defects

### 1. Compact navigation and global search are missing

**Fail:** signed-in header below 768 px has no primary navigation replacement; global search remains hidden below 1024 px. Confirmed with an admin fixture, including breakpoint-adjacent widths. The account menu contains profile, bookmarks, settings and sign-out, not the hidden primary destinations. The feed can offer a contextual Browse games link, and the footer has Home/Discover: those do not replace persistent navigation.

Reproduce: open the signed-in home page at 320 × 740, inspect the header, then open the avatar menu. Compare at 768 and 1024 px.

Owner: `apps/web/src/components/header.tsx`. Implement the agreed navigation direction while preserving role checks.

Evidence: [mobile account menu](artifacts/responsiveness-352/header-menu-320.png).

### 2. Quote and edit dialogs can lose their close and submit controls

**Fail:** 320 × 740 and 740 × 320, English. Reproduced with a valid multiline post: 20 lines of `Line N: audit`, 290 characters, without attachments.

With a normal author name at 320 × 740, the dialog is 868 px tall, starting at y = −64; the close button is entirely above the viewport. At 740 × 320 it is 804 px tall, starting at y = −242, with the submit button at y = 465–497 and close button at y = −226–−194. Computed dialog overflow is `visible`, and the dialog has no internal scroll range to recover the controls.

A separate valid 80-character unbroken author name expands the quote body/composer horizontally: at 320 px, the submit button extends to x ≈ 1307 even though the document width stays about 310. This is why a document overflow assertion alone misses the defect. The initial exploratory post was over the post limit; it was replaced with the 290-character fixture and the failure was reproduced again. Only the valid reproduction is retained here.

Reproduce: create the multiline post, open its Repost menu, choose Quote, and resize. Repeat with an 80-character unbroken display name. No image attachment is required.

Owner: `quote-dialog.tsx`, especially its unconstrained content and author link, composed with the centered grid in `apps/web/src/components/ui/dialog.tsx`. Fix through application-owned width/minimum-size and height/scroll composition. Do not hand-edit the generated primitive. Escape/focus restoration was not conclusively verified: one replay did not dismiss the popup and subsequent commands timed out; this needs a dedicated interaction regression.

The edit dialog has the same height problem with the valid multiline fixture. At 320 × 740 its controls fit, but at 740 × 320 the dialog spans y = −93.5 to 413.5; Close spans −77.5 to −45.5 and Save spans 316.5 to 348.5. Its textarea is internally scrollable, which does not make the outer controls fit. Focusing the close button through agent-browser and pressing Enter dismissed the dialog and restored focus to More. This verifies activation/focus return, not full Tab traversal or touch reachability. Include `edit-post-dialog.tsx` in the application-owned sizing fix. [Edit dialog evidence](artifacts/responsiveness-352/edit-landscape.png).

Evidence: [valid long-author quote](artifacts/responsiveness-352/quote-valid-320.png), [normal-author landscape quote](artifacts/responsiveness-352/quote-normal-landscape.png).

### 3. Long profile names and bios cause document overflow

**Fail:** long name at 320, 768 and 1440 px, both locales. An 80-character unbroken `W` name makes document width about 2001 px on the phone and 2514 px on tablet/desktop. The form's display-name validation requires nonblank text and does not reject this length. A 160-character unbroken `B` bio is within the explicit bio limit.

The bio is independently problematic: temporarily replacing only the rendered heading with a short name still leaves a 1482 px document at 320 px. This was a DOM-only isolation probe; it did not change account data or application source. The bio's text can overflow its paragraph without the paragraph's own bounding box exceeding the viewport.

Reproduce: use those valid values in a fixture profile, then visit its public profile at 320 px. Test each field separately when implementing the regression.

Owner: `profile-layout.tsx`, display-name heading and bio paragraph. Add appropriate minimum-width and wrapping rules; preserve banner and crop framing.

Evidence: [profile at 320 px](artifacts/responsiveness-352/profile-320.png).

### 4. Games sort controls force horizontal page scrolling

**Fail:** `/games`, 320 × 740, both locales. Document width is about 525 px in English and 526 px in French. Release year and Most favorited are offscreen. Reproduces with an empty directory and with a populated local game fixture. A targeted DOM-applied dark-theme check reproduced the same width; the full theme-switch flow was not audited.

Reproduce: open Games at 320 px; inspect all five sort buttons and the document width.

Owner: `games-page.tsx` and its use of `SegmentedControl`, which is an unwrapped inline flex row. The surrounding header wraps, but cannot shrink the control itself. Use an application-owned compact/wrapping or intentionally internally scrollable presentation with accessible options.

Evidence: [Games at 320 px](artifacts/responsiveness-352/games-320.png).

### 5. Privacy-policy table overflows on phones

**Fail:** `/privacy`, 320 × 740, both locales. The data table extends to about 355 px in English and 387 px in French. At tablet and desktop sizes, the baseline document-width check passes.

Reproduce: open Privacy Policy, scroll to the collected-data table and inspect all three columns at 320 px.

Owner: `apps/web/src/components/legal/privacy-policy.tsx` and shared `legal-document.tsx` table styling. The table has no wrapper that contains its intrinsic width. Preserve all legal text and column relationships; either provide readable wrapping or a clearly operable internal table scroll area.

Evidence: [French privacy table](artifacts/responsiveness-352/privacy-fr-320.png).

### 6. Moderation account lookup overflows on long display names

**Fail:** admin account, Team tab, English, 320 × 740. Searching for the long-name fixture makes document width about 1232 px. The name link extends outside its content cell despite nearby `min-w-0`/`truncate` classes.

Reproduce: open Moderation → Team, search for the long-name account, then inspect the result row. The normal roster and initial empty queue did not exhibit this failure.

Owner: `apps/web/src/components/moderation/team-view.tsx`, account-row name/link composition. Verify actual rendered truncation, rather than the presence of a class. The role-change dialog was opened without submitting: controls fit vertically at 320 × 740, but it shares the lost mobile gutter described below.

Evidence: [Team search result](artifacts/responsiveness-352/team-long-320.png).

### 7. Dialog callers lose mobile gutters; consent lacks a short-height policy

**Fail for gutters/viewport containment; normal-size consent action remained reachable.** Consent at 320 × 320 is about 310 px wide with its left edge at x = 0. English height is 292 px; French is 312 px. Both normal acceptance buttons fit at this size. At 568 × 240, French consent is 272 px tall, extending from y = −16 to y = 256; the action still fits, but the whole dialog does not.

This constrained-height check is **not evidence of actual virtual-keyboard behavior**. Do not claim the normal mobile consent action is inaccessible from these measurements.

Reproduce: use an account missing legal consent, open the home page, set the given viewport sizes, and inspect dialog edges. Quote and role-change callers also exhibited the missing horizontal gutter.

Owner: application callers overriding `max-w-*`, including `legal-consent-dialog.tsx`. Their class composition replaces the primitive's mobile maximum-width gutter, while retaining fixed centering and no height/scroll limit. Coordinate layout work with #351; no consent business rules were changed.

Evidence: [short French consent](artifacts/responsiveness-352/consent-fr-short.png).

## Route and state inventory

**Pass below means only the stated rendered state had no unintended horizontal document overflow at the baseline sizes in both locales.** It does not override the shared navigation defect, prove all internal controls, or certify unvisited states. `__root` is covered as shared chrome; the profile parent and index are exercised together. Missing-resource/redirect states are explicitly distinguished from populated routes.

| Route                         | Rendered state and result                                                                         | Still not tested                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/`                           | Pass: populated feed and initial composer layout; fail: compact navigation                        | Following scope, refresh/pagination under load, all loading/error states                                           |
| `/discover`                   | Pass: initial view                                                                                | Every filter, populated recommendations, pagination                                                                |
| `/search`                     | Pass: `q=audit` initial results                                                                   | Long queries, all result types, keyboard suggestion navigation                                                     |
| `/games/`                     | Fail at 320 px: sort row; pass baseline wider geometry                                            | Every sort interaction, pagination, long catalog titles                                                            |
| `/games/$slug`                | Pass: missing-game state in EN baseline; populated local detail at 320 px EN                      | Populated FR/tablet/desktop detail, full media/game rail states                                                    |
| `/bookmarks`                  | Pass: empty state                                                                                 | Populated/paginated states                                                                                         |
| `/notifications`              | Pass: empty state                                                                                 | Populated list, badges, action/clear dialogs                                                                       |
| `/@{$username}` and its index | Pass: ordinary own profile and missing profile; fail: long-name profile                           | Private/requested/suspended states, followers dialogs, badges, populated game rail                                 |
| `/post/$postId`               | Pass: public thread geometry signed in/out, multiline content, initial reply form                 | Populated replies, ancestry pagination, failed submission                                                          |
| `/settings/account`           | Pass: initial passwordless account settings; expanded 2FA password panel at 320 px EN             | Password account, completed 2FA/backup codes, passkey ceremony, linked providers, upload/crop, requests and blocks |
| `/moderation`                 | Pass: initial admin queue in baseline; empty audit view at 320 px EN; fail: Team long-name lookup | Moderator/staff-specific layouts, populated queue/audit, case actions and appeals                                  |
| `/login`                      | Pass: signed-out form                                                                             | Error/submission/passkey/OAuth/expired-session flows                                                               |
| `/register`                   | Pass: initial form                                                                                | Validation errors and completed registration                                                                       |
| `/forgot-password`            | Pass: initial form                                                                                | Submission and confirmation                                                                                        |
| `/reset-password`             | Pass: missing/expired-token message                                                               | Valid-token form and submission                                                                                    |
| `/verify-email`               | Pass: initial check-email view                                                                    | Verification callback, resend and error states                                                                     |
| `/two-factor`                 | Pass: authenticator-code form without challenge                                                   | Real challenge, backup-code mode, invalid-code errors                                                              |
| `/welcome`                    | Signed-out redirects to login; actual incomplete-account form checked separately at 320 px EN/FR  | Completed onboarding and follow-on offers; tablet/desktop matrix                                                   |
| `/banned`                     | Pass: generic signed-out banned page                                                              | Real banned account, reasons and capability links                                                                  |
| `/appeal`                     | Pass: missing-target state                                                                        | Valid capability and post appeal forms, submission/error states                                                    |
| `/terms`                      | Pass: document                                                                                    | 200% zoom and keyboard-only reading                                                                                |
| `/privacy`                    | Fail at 320 px: table; pass wider baseline                                                        | 200% zoom and touch scrolling                                                                                      |
| `/mentions-legales`           | Pass: document                                                                                    | 200% zoom                                                                                                          |
| Not found                     | Signed-out request redirects to login                                                             | Signed-in not-found page                                                                                           |

## Remaining interaction and browser coverage

Not tested unless specifically described above:

- Images: image-only/mixed/max-attachment drafts, uploads, attachment menus, image viewer, avatar/banner crop and original-image framing.
- Dialogs: share, delete, block, report, followers/following, changelog, notification clearing, populated moderation cases; quote submission/errors and attachment composition.
- Global states: analytics banner/preferences (analytics was disabled in the isolated instance), toast collision placement, locale/theme menu keyboard behavior, long notification counts.
- Browsers and input: WebKit/Safari, physical devices, mobile virtual keyboard, touch targets in actual touch mode, 200% browser zoom, safe areas. Resizing desktop Chromium does not substitute for these.
- Exhaustive role/state coverage, successful/failed destructive operations, network error/loading/pagination combinations.

Existing regression coverage is not entirely desktop-only: `compose.spec.ts` already covers the #350 visibility toolbar at 320–641 px in EN/FR and its 320 px popover; feed and settings specs also resize for narrow cards and banner framing. No new regression tests were added during this investigation. Add focused real-browser tests for the reproduced failures when implementing fixes, including control geometry and reachability rather than document width alone. Avoid a global overflow-hiding workaround.

## Original audit verification

The original audit contained only this report, local fixture screenshots and nonsensitive route measurements. Private fixture/state files are ignored and excluded from artifacts.

Completed checks:

- `pnpm format`: passed.
- `pnpm docs:check`: passed.
- `pnpm verify`: passed, including build, lint, typecheck, format check, documentation validation, 1,435 unit tests, database migration checks/setup, and 502 integration tests across 30 files.
- Artifact validation: 159 completed measurements with EN/FR and the three baseline widths; private browser cookies and environment files excluded.
- Browser sessions and the temporary local API/Vite processes were closed after inspection. The isolated audit database was retained.

The existing browser regression suite was not run, and these repository checks do not turn untested browser/device combinations into passes.

## Implementation and verification — 2026-09-08

- Added the four-destination mobile bottom navigation, image-only mobile logo,
  notification bell and role-gated moderation shield. Account actions and theme
  selection are available from the own-profile menu. Global search uses one
  component, also visible below the mobile header on Discover and Search.
- Application-owned dialogs share viewport gutters and internal scrolling;
  quote authors and profile names/bios cannot widen their containing layouts.
  Games sort controls wrap, legal tables constrain their cells, and moderation
  Team names truncate inside their rows, with role actions on a separate mobile row. Generator-owned UI primitives are unchanged.
- Profiles show six favorites, an empty-state link to Games, and a scrollable
  “See more” popover. The favorites API accepts an opaque cursor and returns
  `nextCursor`, with twelve items per page. The popover loads later pages on
  request. Privacy and blocking checks apply on every request. Profile and hover
  preview badges align with the lower edge of the name.

Validation:

- `pnpm format` and `pnpm verify` passed: build, lint, typecheck, formatting,
  documentation, 1,436 unit tests and 502 integration tests across 30 files.
- After the final moderation row spacing adjustment, build/lint/types and all
  1,436 unit tests passed again. The last full run finished with 501/502
  integration tests passing: the unchanged `games-sync.int.test.ts` snapshot
  test found zero catalog rows after a successful sync, where it expected
  1,000. An earlier full run passed all 502; all twelve catalog-sync tests
  subsequently passed in isolation. The cause of this intermittent full-run
  failure is not established; it is not hidden by changing or weakening tests.
- Focused Chromium E2E: four responsiveness tests plus two setup tests passed.
  Covers EN/FR Games sorts and privacy at 320 px; long profile names at
  320/768/1440 px; quote submission at 740 × 320; all four mobile destinations
  and role-gated moderation. The narrow-layout regression was observed failing
  before its fix. The favorites pagination regression also failed before implementation.
- agent-browser: inspected empty profile, six-link preview at mobile/desktop,
  popover pagination from twelve to fifteen links, global search through
  `/search?q=audit`, theme submenu and sign-out entry, and successful edit Save
  in a 740 × 320 viewport. The long-name moderation lookup fits at 320 px;
  legal consent fits a 568 × 240 viewport with internal scrolling. Browser
  error checks returned no JavaScript errors. The favorites popup measured 288 × 512 at x=6, y=127
  within a 320 × 740 viewport. The edit dialog has internal scrolling and fits
  within the viewport instead of extending above and below it.
- The fixtures have no cover media; game covers use the normal missing-cover
  fallback. These screenshots test layout, not image delivery.

After screenshots: [empty profile](artifacts/responsiveness-352/fixed-empty-profile.png),
[mobile search](artifacts/responsiveness-352/fixed-mobile-search.png),
[favorites popover](artifacts/responsiveness-352/fixed-favorites-popover.png),
[loaded favorites](artifacts/responsiveness-352/fixed-full-favorites.png),
[landscape edit](artifacts/responsiveness-352/fixed-edit-fixed.png),
[desktop profile](artifacts/responsiveness-352/fixed-desktop-profile.png),
[moderation lookup](artifacts/responsiveness-352/fixed-team.png).

This pass does not cover Safari, physical mobile devices, virtual keyboards,
all media flows, or every previously inventoried route/state. The original
coverage table records the broader audit and its explicit gaps.

Task-specific browser sessions and local API/Vite inspection servers are stopped.
