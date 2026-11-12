import { useEffect, useState } from 'react';
import { store, useApp } from '../state/store';
import { toast } from '../state/actions';
import { deleteSetup, listSetups, loadSetup, saveSetup, type Setup } from '../state/setups';

const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export function SetupsButton() {
  const open = useApp((s) => s.popover === 'setups');
  return (
    <>
      <button className={open ? 'on' : ''} onClick={() => store.set({ popover: open ? null : 'setups' })}
        title="Save this scene in the browser, or open one you saved">
        💾 Setups
      </button>
      {open && <SetupsPop />}
    </>
  );
}

function SetupsPop() {
  const setupName = useApp((s) => s.setupName);
  const sources = useApp((s) => s.scene.sources.length);
  const [list, setList] = useState<Setup[] | null>(null);
  const [name, setName] = useState(setupName ?? '');
  const [busy, setBusy] = useState(false);

  const refresh = () => listSetups().then(setList).catch((e) => {
    setList([]);
    toast(`Saved setups are unavailable: ${(e as Error).message}`, 'error');
  });
  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    const n = name.trim() || `Setup ${(list?.length ?? 0) + 1}`;
    if (list?.some((s) => s.name === n) && !confirm(`Replace the saved setup “${n}” with the current scene?`)) return;
    setBusy(true);
    try {
      await saveSetup(n);
      setName(n);
      toast(`Saved “${n}”`);
      await refresh();
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const load = async (s: Setup) => {
    if (sources > 0 && setupName !== s.name && !confirm(`Open “${s.name}”?\n\nIt replaces the current scene. Save it first if you want to keep it.`)) return;
    setBusy(true);
    try {
      await loadSetup(s.id);
      toast(`Opened “${s.name}”`);
      store.set({ popover: null });
    } catch (e) {
      toast(`Could not open: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Setup) => {
    if (!confirm(`Delete the saved setup “${s.name}”?`)) return;
    await deleteSetup(s.id).catch((e) => toast(`Could not delete: ${(e as Error).message}`, 'error'));
    if (store.get().setupName === s.name) store.set({ setupName: null });
    await refresh();
  };

  return (
    <div className="render-pop setups-pop" role="dialog" aria-label="Saved setups">
      <div className="rp-head">
        <strong>Saved setups</strong>
        <span className="muted">in this browser</span>
        <button className="icon" onClick={() => store.set({ popover: null })} aria-label="Close">✕</button>
      </div>
      <form className="setup-save" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Setup ${(list?.length ?? 0) + 1}`}
          aria-label="Name for this setup" maxLength={80} />
        <button className="primary" type="submit" disabled={busy}>Save current</button>
      </form>
      {list === null ? (
        <p className="hint">Loading…</p>
      ) : list.length === 0 ? (
        <p className="hint">Nothing saved yet. Saving keeps the scene — sources, motion, room, settings — and its sounds.</p>
      ) : (
        <ul className="setup-list">
          {list.map((s) => (
            <li key={s.id} className={s.name === setupName ? 'on' : ''}>
              <button className="setup-open" onClick={() => load(s)} disabled={busy} title={`Open “${s.name}”`}>
                <span className="nm">{s.name}</span>
                <span className="meta">
                  {s.scene.sources.length} source{s.scene.sources.length === 1 ? '' : 's'} · {when(s.updated)}
                </span>
              </button>
              <button className="icon danger" onClick={() => remove(s)} disabled={busy} title="Delete" aria-label={`Delete ${s.name}`}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
