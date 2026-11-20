import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

/**
 * Compact styled select for settings rows: the `mini-select` button opens a `menu` listbox. Arrow keys move, Enter or Space
 * picks, Escape closes and returns focus to the button. Replaces the hidden native <select>.
 */
export function MiniSelect<T extends string | number>({ label, value, options, onChange, className = '' }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value)?.label ?? String(value);

  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const show = () => { setActive(Math.max(options.findIndex((o) => o.value === value), 0)); setOpen(true); };

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const down = (e: MouseEvent) => {
      if (list.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, active]);

  const pick = (i: number) => { const o = options[i]; close(); if (o && o.value !== value) onChange(o.value); };
  const onListKey = (e: KeyboardEvent) => {
    const n = options.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + n) % n); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <span className="model-picker">
      <button
        ref={btn} type="button" className={`mini-select mini-select--button ${className}`}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${current}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); show(); } }}
      >
        <span>{current}</span>
        <Icon name="chev_down" size={10} opacity={0.66} />
      </button>
      {open && (
        <div
          ref={list} tabIndex={-1} role="listbox" aria-label={label} aria-activedescendant={`${id}-${active}`}
          className="menu model-menu model-menu--plain is-right is-below" onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)} id={`${id}-${i}`} data-index={i} role="option" aria-selected={o.value === value}
              className={`menu__item model-menu__item${i === active ? ' is-active' : ''}`}
              onMouseMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
            >
              <span className="model-menu__check">{o.value === value && <Icon name="check" size={12} />}</span>
              <span className="model-menu__label">{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
