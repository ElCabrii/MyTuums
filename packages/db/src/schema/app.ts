// Application-specific tables live here, kept separate from ./auth.ts so
// that regenerating the BetterAuth schema (`db:generate`, see auth.ts header)
// never clobbers app-owned tables. No app tables exist yet — this file
// establishes the structure for when they're added.
export {};
