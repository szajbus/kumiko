// Icons from the design, drawn at their native sizes.

const HEX = "50,10 84.64,30 84.64,70 50,90 15.36,70 15.36,30";
const SPOKES = "M50 50L50 10M50 50L84.64 30M50 50L84.64 70M50 50L50 90M50 50L15.36 70M50 50L15.36 30";
const LEAVES =
  "M61.55 30L50 50M61.55 30L50 10M61.55 30L84.64 30M73.09 50L50 50M73.09 50L84.64 30M73.09 50L84.64 70" +
  "M61.55 70L50 50M61.55 70L84.64 70M61.55 70L50 90M38.45 70L50 50M38.45 70L50 90M38.45 70L15.36 70" +
  "M26.91 50L50 50M26.91 50L15.36 70M26.91 50L15.36 30M38.45 30L50 50M38.45 30L15.36 30M38.45 30L50 10";

/** The asanoha kumiko mark in hinoki wood. At 32px and below it takes the heavier strokes, as the regular ones blur. */
export function Logo({ size = 28 }: { size?: number }) {
  const [outer, spoke, leaf] = size <= 32 ? [6, 3.6, 3] : [3.2, 1.8, 1.4];
  return (
    <svg width={size} height={size} viewBox="12 8 76 84" fill="none" stroke="#D9B98C" strokeLinecap="round" aria-hidden="true">
      <polygon points={HEX} strokeWidth={outer} strokeLinejoin="round" />
      <path d={SPOKES} strokeWidth={spoke} />
      <path d={LEAVES} strokeWidth={leaf} />
    </svg>
  );
}

export const Plus = ({ size = 16, color = "#FFFFFF" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);

export const Play = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 3.5v9l7.5-4.5z" fill="#4CC38A" />
  </svg>
);

export const Square = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="#C3C8D1" />
  </svg>
);

export const Dots = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.4" fill="#C3C8D1" />
    <circle cx="8" cy="8" r="1.4" fill="#C3C8D1" />
    <circle cx="12.5" cy="8" r="1.4" fill="#C3C8D1" />
  </svg>
);

export const Redo = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M11.5 5.5A5 5 0 1 0 12 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M12 2v3.5H8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Trash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Folder = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M2 5.5a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 16 7.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 13.5z" fill="none" stroke="#C3C8D1" strokeWidth="1.3" />
  </svg>
);

export const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" stroke="#C3C8D1" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** The bento mark, large and quiet, for the empty list. */
export const EmptyBento = () => (
  <svg width="56" height="56" viewBox="0 0 28 28" aria-hidden="true">
    <rect x="1" y="1" width="26" height="26" rx="6" fill="none" stroke="#3A404B" strokeWidth="1.5" />
    <line x1="14" y1="2" x2="14" y2="26" stroke="#3A404B" strokeWidth="1.5" />
    <line x1="14" y1="14" x2="26" y2="14" stroke="#3A404B" strokeWidth="1.5" />
    <circle cx="7.5" cy="14" r="2.5" fill="#8FA6F0" />
  </svg>
);

export const Pencil = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M9.5 2.5l2 2L5 11H3v-2z" fill="none" stroke="#C3C8D1" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Fork = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="4" cy="3" r="1.5" {...stroke} />
    <circle cx="10" cy="3" r="1.5" {...stroke} />
    <circle cx="7" cy="11.5" r="1.5" {...stroke} />
    <path d="M4 4.5v1a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 10 5.5v-1M7 7v3" {...stroke} />
  </svg>
);

export const Return = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M12.5 3.5v4a2 2 0 0 1-2 2h-7M6 6.5l-3 3 3 3" {...stroke} />
  </svg>
);

export const Stop = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
  </svg>
);

export const Check = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7.5l3 3 6-6.5" {...stroke} />
  </svg>
);

export const Save = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 3.5a1 1 0 0 1 1-1h6l2 2v6a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" {...stroke} />
    <path d="M4.5 2.5v3h4v-3M4.5 11.5v-3h5v3" {...stroke} />
  </svg>
);

export const Resume = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M4 2.5v9l7-4.5z" {...stroke} />
  </svg>
);

export const Paperclip = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M13 7.5l-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.3 11.2a1.05 1.05 0 0 1-1.5-1.5L10 4.5" {...stroke} />
  </svg>
);

export const Close = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" {...stroke} />
  </svg>
);

export const Rewind = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.3M2.5 1.8v2.4h2.4" {...stroke} />
  </svg>
);
