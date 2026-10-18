import { useEffect, useState } from "react";
import { useLiveState } from "./api";
import { CreateForm } from "./CreateForm";
import { SandboxList } from "./SandboxList";
import { SandboxPage } from "./SandboxPage";

type Route = { view: "list" } | { view: "new" } | { view: "sandbox"; name: string };

function parseHash(): Route {
  if (location.hash === "#/new") return { view: "new" };
  const m = /^#\/sandbox\/([a-z0-9-]+)$/.exec(location.hash);
  return m ? { view: "sandbox", name: m[1] } : { view: "list" };
}

const go = (hash: string) => {
  location.hash = hash;
};

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
      return <SandboxPage key={route.name} name={route.name} live={live} onBack={() => go("#/")} />;
    default:
      return <SandboxList live={live} onOpen={(name) => go(`#/sandbox/${name}`)} onNew={() => go("#/new")} />;
  }
}
