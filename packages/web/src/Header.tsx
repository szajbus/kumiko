import { Logo } from "./icons";

export function Header() {
  return (
    <header className="app-header">
      <div className="brand">
        <Logo size={18} />
        <span className="brand-name">Bentomo</span>
      </div>
    </header>
  );
}
