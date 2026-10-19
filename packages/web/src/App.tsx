import { useEffect, useState } from "react";
import { useLiveState } from "./api";
import { CreateForm } from "./CreateForm";
import { SandboxList } from "./SandboxList";
import { SandboxPage } from "./SandboxPage";

type Route = { view: "list" } | { view: "new" } | { view: "sandbox"; name: string } | { view: "edit"; name: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
  const m = /^#\/sandbox\/([a-z0-9-]+)(\/edit)?$/.exec(location.hash);
  if (!m) return { view: "list" };
  return m[2] ? { view: "edit", name: m[1] } : { view: "sandbox", name: m[1] };
}

const go = (hash: string) => {
  location.hash = hash;
};

function Redirect({ to }: { to: string }) {
  useEffect(() => go(to), [to]);
  return null;
}

export function App() {
  const live = useLiveState();
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  switch (route.view) {
    case "new":
      return <CreateForm onCancel={() => go("#/")} onCreated={(name) => go(`#/sandbox/${name}`)} />;
    case "sandbox":
      return (
        <SandboxPage key={route.name} name={route.name} live={live} onBack={() => go("#/")} onEdit={() => go(`#/sandbox/${route.name}/edit`)} />
      );
    case "edit": {
      const sb = live.sandboxes.find((s) => s.name === route.name);
      const back = () => go(`#/sandbox/${route.name}`);
      // Wait for the list before deciding; then edit only sandboxes Bentomo created.
      if (!live.loaded) return null;
      if (!sb?.meta) return <Redirect to={`#/sandbox/${route.name}`} />;
      return <CreateForm key={`edit-${route.name}`} editing={sb} onCancel={back} onCreated={back} />;
    }
    default:
      return <SandboxList live={live} onOpen={(name) => go(`#/sandbox/${name}`)} onNew={() => go("#/new")} />;
  }
}
