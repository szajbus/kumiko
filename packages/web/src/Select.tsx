import * as RS from "@radix-ui/react-select";

export interface SelectGroup {
  label?: string;
  options: string[];
  /** Listed but can't be picked. */
  disabled?: boolean;
}

interface Props {
  id?: string;
  value: string;
  onValueChange(v: string): void;
  groups: SelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A styled dropdown; the list opens below the trigger at its width and scrolls when long. */
export function Select({ id, value, onValueChange, groups, placeholder, disabled, mono }: Props) {
  return (
    <RS.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RS.Trigger id={id} className={`select-trigger${mono ? " mono" : ""}`}>
        <RS.Value placeholder={placeholder} />
        <RS.Icon className="select-chevron">
          <Chevron />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className={`select-content${mono ? " mono" : ""}`} position="popper" sideOffset={4}>
          <RS.Viewport className="select-viewport">
            {groups.map((g, i) => (
              <RS.Group key={g.label ?? i}>
                {i > 0 && <RS.Separator className="select-separator" />}
                {g.label && <RS.Label className="select-label">{g.label}</RS.Label>}
                {g.options.map((o) => (
                  <RS.Item key={o} value={o} className="select-item" disabled={g.disabled}>
                    <RS.ItemText>{o}</RS.ItemText>
                    <RS.ItemIndicator className="select-check">
                      <Check />
                    </RS.ItemIndicator>
                  </RS.Item>
                ))}
              </RS.Group>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
