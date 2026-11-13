/** The switch between Kumiko's own pages under the home button: Projects and Repos. */
export function HomeNav({ active, projects, repos }: { active: "projects" | "repos"; projects?: number; repos?: number }) {
  const link = (id: "projects" | "repos", href: string, label: string, count?: number) => (
    <a href={href} className={`home-nav-link${active === id ? " is-active" : ""}`} aria-current={active === id ? "page" : undefined}>
      {label}
      {count ? <span className="home-nav-count">{count}</span> : null}
    </a>
  );
  return (
    <nav className="home-nav" aria-label="Kumiko">
      {link("projects", "#/", "Projects", projects)}
      {link("repos", "#/repos", "Repos", repos)}
    </nav>
  );
}
