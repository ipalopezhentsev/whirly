import { useState, type ReactNode } from 'react';
import { clamp } from '../audio/util';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Logarithmic slider (for frequencies). */
  log?: boolean;
  /** Typed values may go beyond the slider range up to these limits. */
  hardMin?: number;
  hardMax?: number;
  title?: string;
  onChange: (v: number) => void;
}

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length;

export function Slider({ label, value, min, max, step = 0.01, unit, log, hardMin, hardMax, title, onChange }: SliderProps) {
  const [text, setText] = useState<string | null>(null);
  const toPos = (v: number) => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : v);
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p / 1000) : p);
  const fmt = (v: number) => (log ? String(v >= 100 ? Math.round(v) : +v.toFixed(1)) : String(+v.toFixed(decimals(step))));

  const commit = () => {
    if (text === null) return;
    const v = parseFloat(text);
    setText(null);
    if (Number.isFinite(v)) onChange(clamp(v, hardMin ?? min, hardMax ?? max));
  };

  return (
    <div className="ctl" title={title}>
      <span className="lbl">{label}</span>
      <input
        type="range"
        min={log ? 0 : min}
        max={log ? 1000 : max}
        step={log ? 1 : step}
        value={toPos(clamp(value, min, max))}
        onChange={(e) => {
          const v = fromPos(+e.target.value);
          onChange(log ? +fmt(v) : v);
        }}
      />
      <input
        className="num"
        type="number"
        step={log ? 'any' : step}
        value={text ?? fmt(value)}
        onFocus={() => setText(fmt(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <span className="unit">{unit}</span>
    </div>
  );
}

interface SelectProps<T extends string> {
  label?: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}

export function Select<T extends string>({ label, value, options, onChange }: SelectProps<T>) {
  const sel = (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
  return label ? <Field label={label}>{sel}</Field> : sel;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ctl field">
      <span className="lbl">{label}</span>
      {children}
    </div>
  );
}

export function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sec">
      <h4>
        <span>{title}</span>
        {aside}
      </h4>
      {children}
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export const Hint = ({ children }: { children: ReactNode }) => <p className="hint">{children}</p>;
