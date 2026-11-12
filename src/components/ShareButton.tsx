import { useState } from 'react';
import { store, useApp } from '../state/store';
import { toast } from '../state/actions';
import { buildShareLink, LONG_URL, MAX_URL, type ShareLink } from '../state/share';

/**
 * Copy text that is still being computed. Safari only allows clipboard writes during the click
 * itself, so the write starts right away with a promised value; elsewhere fall back to writeText.
 */
async function copyLater(text: Promise<string>) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

const kb = (n: number) => (n < 10_000 ? `${n.toLocaleString()} characters` : `${Math.round(n / 1000).toLocaleString()} k characters`);

export function ShareButton() {
  const hasSources = useApp((s) => s.scene.sources.length > 0);
  const open = useApp((s) => s.popover === 'share');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    setBusy(true);
    setLink(null);
    const built = buildShareLink().then((l) => {
      if (l.url.length > MAX_URL) throw new Error('too long');
      return l;
    });
    const copying = copyLater(built.then((l) => l.url));
    try {
      setLink(await built);
      setCopied(await copying);
      store.set({ popover: 'share' });
    } catch (e) {
      toast(
        (e as Error).message === 'too long'
          ? 'The recorded / imported sounds are too long to fit in a link. Trim them and try again.'
          : `Could not create the link: ${(e as Error).message}`,
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const copyAgain = async () => setCopied(await copyLater(Promise.resolve(link!.url)));

  return (
    <>
      <button onClick={share} disabled={busy || !hasSources}
        title={hasSources ? 'Copy a link to this scene, sounds included, to send to someone' : 'Add a source to the scene first'}>
        {busy ? 'Packing…' : '🔗 Share'}
      </button>
      {link && open && (
        <div className="render-pop share-pop" role="dialog" aria-label="Share link">
          <div className="rp-head">
            <strong>{copied ? 'Link copied' : 'Share link'}</strong>
            <span className="muted">{kb(link.url.length)}</span>
            <button className="icon" onClick={() => store.set({ popover: null })} aria-label="Close">✕</button>
          </div>
          <input className="share-url mono" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
          <div className="btns">
            <button className="primary" onClick={copyAgain}>{copied ? '✓ Copied' : 'Copy link'}</button>
            {typeof navigator.share === 'function' && (
              <button onClick={() => navigator.share({ title: 'Whirly scene', url: link.url }).catch(() => {})}>Share…</button>
            )}
          </div>
          <p className="hint">
            Opening it shows this scene — positions, motion, room and settings — with its sounds.
            {link.embedded > 0
              ? ` ${link.embedded} recorded or imported sound${link.embedded === 1 ? ' is' : 's are'} embedded (${link.embeddedSecs.toFixed(1)} s, reduced to 24 kHz / 8-bit).`
              : ' Synthesized sounds are rebuilt from their recipe, so the link stays short.'}
          </p>
          {link.url.length > LONG_URL && (
            <p className="hint warn">Long link: some chat apps cut links this long. Email works, or trim the embedded sounds.</p>
          )}
        </div>
      )}
    </>
  );
}
