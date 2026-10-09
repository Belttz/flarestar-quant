import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api.js';
import { useLanguage } from './i18n.js';
import brandMark from './assets/brand-mark.svg';

/**
 * Full-screen operator sign-in for cloud deployments. A successful login sets
 * the hardened session cookie, then reloads so the workspace boots with live
 * data from the first render.
 */
export function LoginPage() {
  const { t, language } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setErrorCode('invalid_credentials');
      return;
    }
    setBusy(true);
    setErrorCode(null);
    try {
      await api.auth.login(username.trim(), password);
      window.location.reload();
    } catch (cause) {
      setErrorCode(cause instanceof ApiError ? cause.code : 'backend_unavailable');
      setBusy(false);
    }
  };

  return <div className="login-screen">
    <form className="login-card" onSubmit={submit} aria-label={t('Operator sign-in')}>
      <div className="login-brand">
        <img src={brandMark} alt="" aria-hidden="true" />
        <strong>星闪量化</strong>
        <small>FlareStar Quant · Gate CrossEx</small>
      </div>
      <label>
        <span>{t('Username')}</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoFocus
          dir={language === 'zh' ? undefined : 'ltr'}
        />
      </label>
      <label>
        <span>{t('Password')}</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </label>
      {errorCode && <p className="login-error" role="alert">{t(errorCode)}</p>}
      <button type="submit" disabled={busy || !username.trim() || !password}>
        {busy ? t('Signing in…') : t('Sign in')}
      </button>
      <small className="login-hint">{t('Cloud deployment requires signing in to the terminal.')}</small>
    </form>
  </div>;
}
