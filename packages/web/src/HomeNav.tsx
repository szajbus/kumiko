/** The switch between Kumiko's own pages under the home button: Sandboxes and Repos. */
export function HomeNav({ active, sandboxes, repos }: { active: "sandboxes" | "repos"; sandboxes?: number; repos?: number }) {
  const link = (id: "sandboxes" | "repos", href: string, label: string, count?: number) => (
    <a href={href} className={`home-nav-link${active === id ? " is-active" : ""}`} aria-current={active === id ? "page" : undefined}>
      {label}
      {count ? <span className="home-nav-count">{count}</span> : null}
    </a>
  );
  return (
    <nav className="home-nav" aria-label="Kumiko">
      {link("sandboxes", "#/", "Sandboxes", sandboxes)}
      {link("repos", "#/repos", "Repos", repos)}
    </nav>
  );
}
