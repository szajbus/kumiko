// Icons from the design, drawn at their native sizes.

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="6" fill="none" stroke="#E6E8EC" strokeWidth="2" />
      <line x1="14" y1="2" x2="14" y2="26" stroke="#E6E8EC" strokeWidth="2" />
      <line x1="14" y1="14" x2="26" y2="14" stroke="#E6E8EC" strokeWidth="2" />
      <circle cx="7.5" cy="14" r="2.5" fill="#8FA6F0" />
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

export const Wrench = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 11l4.2-4.2M8.6 2.2a2.8 2.8 0 0 0 3.2 3.2l-1.3 1.3a2.8 2.8 0 0 1-3.6-3.6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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
