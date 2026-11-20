import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { EngineProvider } from '@shared/types';
import { Icon } from './Icon';

export interface ModelRef { provider: string | null; model: string | null }

export interface TriggerProps { open: boolean; toggle: () => void; ref: Ref<HTMLButtonElement>; 'aria-haspopup': 'listbox'; 'aria-expanded': boolean; 'aria-label': string }
export type TriggerRender = (props: TriggerProps) => ReactNode;

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };

/** One choosable line in the list. `null` model = the "default" row (production model, or the agent's own). */
interface Option { key: string; provider: string | null; model: string | null; label: string; hint?: string; action?: () => void }

const same = (a: ModelRef, b: ModelRef) => (a.model ?? null) === (b.model ?? null) && (!a.model || (a.provider ?? null) === (b.provider ?? null));

/**
 * Styled model menu: a filter field, then the connected providers' models grouped under each provider, then the
 * providers that are not connected (collapsed). Typing an id that is not listed offers it as a custom model for the
 * current provider. Arrow keys move, Enter picks, Escape closes and returns focus to the trigger.
 */
export function ModelPicker({
  label, providers, value, production, defaultLabel, onPick, actions = [], align = 'right', placement = 'below', trigger, onOpen, loading,
}: {
  label: string;
  providers: EngineProvider[];
  value: ModelRef;
  /** Marks the Agent's production model in the list. */
  production?: ModelRef;
  /** When set, the list starts with a row that clears the choice (value.model = null). */
  defaultLabel?: string;
  onPick: (next: ModelRef) => void;
  /** Extra commands under the list, e.g. "Set as production model". */
  actions?: { label: string; onSelect: () => void }[];
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
  trigger: TriggerRender;
  /** Called when the menu opens, e.g. to load the provider list. */
  onOpen?: () => void;
  /** The provider list is still loading. */
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showOthers, setShowOthers] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const connected = providers.filter((p) => p.connected);
  const others = providers.filter((p) => !p.connected);
  const q = query.trim().toLowerCase();

  const groups = connected
    .map((p) => ({ p, models: p.models.filter((m) => !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) }))
    .filter((g) => g.models.length);

  // Flat list in display order, for the keyboard.
  const options: Option[] = [];
  if (defaultLabel && !q) options.push({ key: 'default', provider: null, model: null, label: defaultLabel });
  for (const g of groups) for (const m of g.models) {
    options.push({ key: `${g.p.id}/${m}`, provider: g.p.id, model: m, label: m, hint: production && same(production, { provider: g.p.id, model: m }) ? 'Production' : undefined });
  }
  const typed = query.trim();
  const customProvider = value.provider ?? production?.provider ?? connected[0]?.id ?? null;
  // Offer a custom id only when nothing listed matches, so a partial search never adds noise.
  if (typed && !groups.length) options.push({ key: 'custom', provider: customProvider, model: typed, label: `Use “${typed}”`, hint: providers.find((p) => p.id === customProvider)?.name });
  for (const a of actions) options.push({ key: `action:${a.label}`, provider: null, model: null, label: a.label, action: a.onSelect });

  const close = (refocus = true) => {
    setOpen(false); setQuery(''); setShowOthers(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Outside click closes without stealing focus from where the person clicked.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);

  // Start on the current choice so Enter keeps it, also when the list arrives after the menu opened.
  const moved = useRef(false);
  useEffect(() => {
    if (!open) { moved.current = false; return; }
    if (moved.current) return;
    const i = options.findIndex((o) => !o.action && (o.model === null ? !value.model : same(o, value)));
    setActive(i < 0 ? 0 : i);
  }, [open, options.length]);
  useEffect(() => { if (open) setActive((i) => Math.min(i, Math.max(options.length - 1, 0))); }, [query]);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (o: Option) => {
    close();
    if (o.action) o.action();
    else if (!(o.model === null ? !value.model : same(o, value))) onPick({ provider: o.provider, model: o.model });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') moved.current = true;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % Math.max(options.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + options.length) % Math.max(options.length, 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(options.length - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o) choose(o); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  const optionId = (i: number) => `${id}-opt-${i}`;
  const row = (o: Option, i: number) => {
    const selected = !o.action && (o.model === null ? !value.model : same(o, value));
    return (
      <div
        key={o.key} id={optionId(i)} data-index={i} role="option" aria-selected={selected}
        className={`menu__item model-menu__item${i === active ? ' is-active' : ''}${o.action ? ' is-action' : ''}`}
        onMouseMove={() => { moved.current = true; setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}
      >
        <span className="model-menu__check">{selected && <Icon name="check" size={12} />}</span>
        <span className={`model-menu__label${o.model && !o.action && o.key !== 'custom' ? ' is-id' : ''}`}>{o.label}</span>
        {o.hint && <span className="menu__hint">{o.hint}</span>}
      </div>
    );
  };

  let i = 0;
  const defaultRow = defaultLabel && !q ? options[0] : null;
  const actionRows = options.filter((o) => o.action);
  const custom = options.find((o) => o.key === 'custom');

  return (
    <span className="model-picker">
      {trigger({
        open, ref: triggerRef, toggle: () => { if (open) close(); else { setOpen(true); onOpen?.(); } },
        'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': `${label}: ${value.model ?? defaultLabel ?? 'Default'}`,
      })}
      {open && (
        <div ref={boxRef} className={`menu model-menu is-${align} is-${placement}`}>
          <div className="model-menu__search">
            <Icon name="search" size={12} opacity={0.5} />
            <input
              autoFocus role="combobox" aria-label={`Find a model for ${label.toLowerCase()}`} aria-expanded aria-controls={`${id}-list`}
              aria-activedescendant={options.length ? optionId(active) : undefined} aria-autocomplete="list"
              className="model-menu__input" placeholder="Find or type a model id" spellCheck={false} autoComplete="off"
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            />
          </div>
          <div id={`${id}-list`} role="listbox" aria-label={label} className="model-menu__list">
            {defaultRow && row(defaultRow, i++)}
            {groups.map((g) => (
              <div key={g.p.id} role="group" aria-label={g.p.name}>
                <div className="menu__header model-menu__group"><span>{g.p.name}</span><span>{KIND[g.p.kind]}</span></div>
                {g.models.map(() => row(options[i], i++))}
              </div>
            ))}
            {custom && row(custom, i++)}
            {!groups.length && !custom && <div className="menu__header">{loading ? 'Loading models…' : q ? 'No match. Type a full model id to use it.' : 'No connected models.'}</div>}
          </div>
          {actionRows.length > 0 && <div className="model-menu__actions" role="listbox" aria-label="Actions">{actionRows.map((o) => row(o, i++))}</div>}
          {others.length > 0 && !q && (
            <div className="model-menu__others">
              <button type="button" className="menu__item model-menu__toggle" aria-expanded={showOthers} onMouseDown={(e) => e.preventDefault()} onClick={() => setShowOthers((s) => !s)}>
                <span>Not connected · {others.length}</span>
                <Icon name={showOthers ? 'chev_down' : 'chev_right'} size={10} opacity={0.56} />
              </button>
              {showOthers && others.map((p) => (
                <div key={p.id} className="menu__item model-menu__item is-off" aria-disabled>
                  <span className="model-menu__check" />
                  <span className="model-menu__label">{p.name}</span>
                  <span className="menu__hint">{KIND[p.kind]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
