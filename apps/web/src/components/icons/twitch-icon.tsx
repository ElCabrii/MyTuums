/**
 * Twitch's official "Glitch" mark (the icon-only symbol), traced from the
 * White variant in Twitch's public brand kit
 * (https://brand.twitch.tv). Twitch ships this mark in Purple, White, Black
 * Ops and Ice specifically for use on different backgrounds, so — like the
 * Discord symbol — this uses `currentColor` rather than baking in a fixed
 * color, and the button sets it to white against the Twitch Purple fill.
 */
import type { CSSProperties } from "react";

export function TwitchIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 2400 2800"
      className={className}
      style={style}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M500,0L0,500v1800h600v500l500-500h400l900-900V0H500z M2200,1300l-400,400h-400l-350,350v-350H600V200h1600V1300z" />
      <rect x="1700" y="550" width="200" height="600" />
      <rect x="1150" y="550" width="200" height="600" />
    </svg>
  );
}
