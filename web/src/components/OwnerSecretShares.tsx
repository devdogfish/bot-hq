import { useEffect, useState } from 'react';
import { ApiError, api, type OwnerSecretMetadata } from '../lib/api';
import { Icon } from './Icon';

const KIND: Record<OwnerSecretMetadata['kind'], string> = {
  login: 'Login',
  phone: 'Phone number',
  code: 'Code',
  text: 'Private text',
};

function expiryLabel(expiresAt: OwnerSecretMetadata['expires_at']) {
  if (expiresAt === null) return null;
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? null : `Expires ${date.toLocaleString()}`;
}

export function OwnerSecretShares({ botId }: { botId: string }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shares, setShares] = useState<OwnerSecretMetadata[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revocations, setRevocations] = useState<Record<string, 'pending' | 'revoked' | 'failed'>>({});

  useEffect(() => {
    if (!open) return;
    let active = true;
    api.ownerSecrets(botId).then((items) => {
      if (active) setShares(items);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error instanceof ApiError && error.status === 409
        ? 'Set the owner-secret token in Agent connection.'
        : 'Couldn’t load shared items.');
    });
    return () => { active = false; };
  }, [botId, open, attempt]);

  async function revoke(ref: string) {
    setRevocations((current) => ({ ...current, [ref]: 'pending' }));
    try {
      await api.revokeOwnerSecret(botId, ref);
      setRevocations((current) => ({ ...current, [ref]: 'revoked' }));
    } catch {
      setRevocations((current) => ({ ...current, [ref]: 'failed' }));
    }
  }

  const visible = shares?.filter(({ ref }) => revocations[ref] !== 'revoked');
  return (
    <details className="engine__disclosure" onToggle={(event) => {
      const nextOpen = event.currentTarget.open;
      setOpen(nextOpen);
      if (!nextOpen) {
        setShares(null);
        setLoadError(null);
      }
    }}>
      <summary className="panel-row panel-row--link engine__summary">
        <span className="engine__summary-title">Shared with this Agent</span>
        <Icon name="chev_right" size={10} opacity={0.56} className="engine__summary-chev" />
      </summary>
      {open && (loadError ? (
        <div className="panel-empty" role="alert">
          {loadError}{' '}
          <button type="button" className="link-btn link-btn--small" onClick={() => {
            setLoadError(null);
            setAttempt((current) => current + 1);
          }}>Try again</button>
        </div>
      ) : !visible ? (
        <div className="panel-empty" role="status">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="panel-empty" role="status">No shared items.</div>
      ) : (
        <ul className="owner-secret-shares">
          {visible.map((item) => (
            <li key={item.ref}>
              <div className="panel-row">
                <div className="panel-row__text">
                  <span className="panel-row__title">{item.label}</span>
                  <span className="panel-row__sub">{item.site}</span>
                  <span className="panel-row__meta">
                    {[KIND[item.kind], item.one_time ? 'One use' : 'Remembered', expiryLabel(item.expires_at)].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <button type="button" className="link-btn link-btn--small" aria-label={`Revoke ${item.label}`}
                  disabled={revocations[item.ref] === 'pending'} onClick={() => void revoke(item.ref)}>
                  {revocations[item.ref] === 'pending' ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
              {revocations[item.ref] === 'failed' && <div className="panel-empty" role="alert">Couldn’t revoke this item. Try again.</div>}
            </li>
          ))}
        </ul>
      ))}
    </details>
  );
}
