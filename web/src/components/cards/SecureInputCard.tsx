import { useState, type FormEvent } from 'react';
import type { SecureInputCard as SecureInputBody, SecureInputResult } from '@shared/types';
import { ApiError, api } from '../../lib/api';
import { Icon } from '../Icon';

type Decision = 'submit' | 'decline';

const SHARED: Record<SecureInputBody['kind'], string> = {
  login: 'Sign-in details shared',
  phone: 'Phone number shared',
  code: 'Code shared',
  text: 'Private text shared',
};

/** A resolved request collapses to one line, like a tool receipt, so the conversation stays readable. */
function SecureInputPill({ body, status }: { body: SecureInputBody; status: SecureInputResult['status'] | 'unavailable' }) {
  const ready = status === 'ready';
  const text = ready ? SHARED[body.kind] : status === 'declined' ? 'Request declined' : 'Request expired';
  return (
    <div className={`secure-pill${ready ? '' : ' is-off'}`} role="status" title={ready ? `${body.label} · ${body.site}` : status === 'unavailable' ? 'Ask the Agent for a new request.' : body.site}>
      <span className="secure-pill__icon"><Icon name="lock" size={16} /></span>
      <span className="secure-pill__text">{text}</span>
      <Icon name={ready ? 'check' : 'close'} size={16} opacity={ready ? 0.9 : 0.6} />
    </div>
  );
}

export function SecureInputCard({ body }: { body: SecureInputBody }) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<SecureInputResult['status'] | 'unavailable' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = body.status === 'pending' ? outcome ?? body.status : body.status;
  const pending = status === 'pending';

  async function decide(decision: Decision, form: HTMLFormElement) {
    if (!pending || busy) return;
    setBusy(decision);
    setError(null);
    try {
      if (decision === 'submit') {
        const data = new FormData(form);
        const remember = data.has('remember');
        data.delete('remember');
        const fields: Record<string, string> = {};
        for (const [name, value] of data) {
          if (typeof value === 'string' && value !== '') fields[name] = value;
        }
        const { status } = await api.secureInput(body.requestId, {
          decision,
          fields,
          ...(body.kind === 'phone' ? { one_time: !remember } : {}),
        });
        setOutcome(status);
      } else {
        const { status } = await api.secureInput(body.requestId, { decision });
        setOutcome(status);
      }
      form.reset();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : null;
      if (status === 404 || status === 410) {
        form.reset();
        setOutcome('unavailable');
      } else if (status === 400 || status === 413) {
        setError('Check the requested fields and try again.');
      } else if (error instanceof ApiError && (status === 409 || status === 422 || status === 502)) {
        setError(error.message);
      } else {
        setError('Couldn’t resolve this request. Try again.');
      }
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void decide('submit', event.currentTarget);
  }

  if (!pending) return <SecureInputPill body={body} status={status} />;

  return (
    <div className="card secure-input-card">
      <div className="card__head">
        <div className="card__titles">
          <div className="card__title">{body.label}</div>
          <div className="card__sub">{body.site} · Secure input</div>
        </div>
      </div>
      {body.reason && <div className="card__body">{body.reason}</div>}
      {pending ? (
        <form method="post" action={`/api/secure-input/${encodeURIComponent(body.requestId)}`}
          autoComplete="off" onSubmit={submit} aria-busy={!!busy}>
          <fieldset className="secure-input-card__fields" disabled={!!busy}>
            {body.kind === 'login' ? (
              <>
                <label>Username
                  <input className="text-input" name="username" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required />
                </label>
                <label>Password
                  <input className="text-input" name="password" type="password" autoComplete="off" required />
                </label>
                <label>TOTP seed (optional)
                  <input className="text-input" name="totp" type="password" autoComplete="off" />
                </label>
              </>
            ) : body.kind === 'phone' ? (
              <>
                <label>Phone number
                  <input className="text-input" name="phone" type="password" inputMode="tel" autoComplete="off" pattern="[+][1-9][0-9]{1,14}" required />
                  <span className="secure-input-card__hint">Include the country code with no spaces, e.g. +15555550101.</span>
                </label>
                <label className="secure-input-card__remember">
                  <input type="checkbox" name="remember" defaultChecked={!body.oneTime} /> Remember for this Agent
                </label>
              </>
            ) : (
              <label>{body.kind === 'code' ? 'Code' : 'Private text'}
                <input className="text-input" name="value" type="password" autoComplete="off" required />
              </label>
            )}
          </fieldset>
          {body.kind !== 'phone' && (
            <div className="card__body">
              {body.oneTime ? 'Expires after one fill or ten minutes.' : 'Stored in the Agent’s vault until you revoke it.'}
            </div>
          )}
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={(event) => {
              const { form } = event.currentTarget;
              if (form) void decide('decline', form);
            }}>
              {busy === 'decline' ? 'Declining…' : 'Decline'}
            </button>
            <button type="submit" className="btn btn--primary" disabled={!!busy}>{busy === 'submit' ? 'Sharing…' : 'Share securely'}</button>
          </div>
        </form>
      ) : (
        <div className="card__outcome" role="status">
          <Icon name={status === 'ready' ? 'check' : 'close'} size={12} opacity={0.7} />
          {status === 'ready' ? 'Shared securely' : status === 'declined' ? 'Declined' : 'Request unavailable. Ask the Agent for a new request.'}
        </div>
      )}
      {pending && error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}
