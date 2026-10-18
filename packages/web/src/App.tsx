import { useEffect, useState } from "react";
import { useLiveState } from "./api";
import { CreateForm } from "./CreateForm";
import { SandboxList } from "./SandboxList";

type View = "list" | "new";

const viewFromHash = (): View => (location.hash === "#/new" ? "new" : "list");

export function App() {
  const live = useLiveState();
  const [view, setView] = useState<View>(viewFromHash);
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const go = (v: View) => {
    location.hash = v === "new" ? "#/new" : "#/";
  };

  if (view === "new") {
    return (
      <CreateForm
        onCancel={() => go("list")}
        onCreated={(name) => {
          setSelected(name);
          go("list");
        }}
      />
    );
  }
  return <SandboxList live={live} selected={selected} onSelect={setSelected} onNew={() => go("new")} />;
}
