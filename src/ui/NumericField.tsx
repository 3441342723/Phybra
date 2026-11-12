import { useEffect, useState } from 'react';
import type { Num, UnitKind } from '../model/types';
import { defaultUnit, fromSI, toSI, UNITS } from '../model/units';

type Props = {
  label: string;
  value: Num;
  unitKind: UnitKind;
  min?: number;
  max?: number;
  step?: number;
  boundName?: string;
  hint?: string;
  disabled?: boolean;
  onTransient: (value: Num) => void;
  onCommit: (value: Num) => void;
};

/** 数值输入 + 单位 + 滑块：三者操作同一个物理量，单位切换不改变 SI 值 */
export function NumericField({ label, value, unitKind, min, max, step = 0.1, boundName, hint, disabled, onTransient, onCommit }: Props) {
  const [unit, setUnit] = useState(defaultUnit(unitKind));
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const factor = toSI(1, unit, unitKind) ?? 1;
  const display = value === null ? '' : String(Number((fromSI(value, unit, unitKind) ?? 0).toPrecision(6)));

  useEffect(() => {
    setText(display);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);

  const commitText = () => {
    if (text.trim() === '' || text.trim() === '?') {
      setError(false);
      onCommit(null);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setError(true);
      return;
    }
    setError(false);
    const si = toSI(parsed, unit, unitKind);
    if (si === null) setError(true);
    else onCommit(si);
  };

  const slider = min !== undefined && max !== undefined && !disabled;
  return (
    <div className={`numfield${error ? ' has-error' : ''}`}>
      <div className="numfield-head">
        <label>{label}</label>
        {boundName && <span className="badge" title="该属性绑定到命名参数，修改会同步到参数">= {boundName}</span>}
      </div>
      <div className="numfield-row">
        <input
          className="num-input"
          value={text}
          placeholder="未知"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(display);
          }}
        />
        {unitKind !== 'none' ? (
          <select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={disabled}>
            {Object.keys(UNITS[unitKind]).map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        ) : (
          <span className="unitless">无量纲</span>
        )}
        <button className="mini" title="设为未知（不猜测数值）" disabled={disabled} onClick={() => onCommit(null)}>∅</button>
      </div>
      {slider && (
        <input
          type="range"
          className="slider"
          min={min / factor}
          max={max / factor}
          step={step / factor}
          value={value === null ? min / factor : (fromSI(value, unit, unitKind) ?? 0)}
          disabled={value === null}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const si = toSI(Number(e.target.value), unit, unitKind);
            if (si !== null) onTransient(si);
          }}
          onPointerUp={(e) => {
            const si = toSI(Number((e.target as HTMLInputElement).value), unit, unitKind);
            if (si !== null) onCommit(si);
          }}
          onKeyUp={(e) => {
            const si = toSI(Number((e.target as HTMLInputElement).value), unit, unitKind);
            if (si !== null) onCommit(si);
          }}
        />
      )}
      {value === null && <div className="hint">未赋值：保持未知，尚不可定量求解</div>}
      {hint && <div className="hint">{hint}</div>}
      {error && <div className="hint error">无法解析的数值</div>}
    </div>
  );
}
