import type { ReactNode } from "react";
import { Logo } from "./icons";

export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="brand">
        <Logo size={18} />
        <span className="brand-name">Bentomo</span>
      </div>
      {children}
    </header>
  );
}
