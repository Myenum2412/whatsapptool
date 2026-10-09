import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { API_BASE_URL } from '../services/api';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: string) => void;
  /** Pre-filled email after a successful signup, so the user just types the password. */
  initialEmail?: string;
  /** Switch to the signup view (rendered by App when unauthenticated). */
  onSwitch?: () => void;
  /** One-shot success notice (e.g. "account created") shown above the form. */
  notice?: string;
}

interface LoginResponse {
  apiKey?: string;
  role?: string;
}

export function Login({ onLogin, initialEmail, onSwitch, notice }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // The login screen is English-only (no language picker): pin the locale so a stored or
  // browser-detected preference cannot render this screen in another language.
  useEffect(() => {
    void i18n.changeLanguage('en');
  }, [i18n]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError(t('login.emailRequired'));
      return;
    }
    if (!password) {
      setError(t('login.passwordRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (response.ok) {
        // The login body already carries the freshly issued key and its role — hand them up so the
        // app can store both without a second request. An unexpected body shape is treated as a
        // failure rather than crashing with an empty key.
        const data: LoginResponse = await response.json().catch(() => ({}));
        if (data.apiKey) {
          onLogin(data.apiKey, data.role);
        } else {
          setError(t('login.connectionError'));
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        // 401 is always the user's credentials; anything else (400 validation, 429 rate limit,
        // 5xx) surfaces the server's detail when it offers one.
        setError(
          response.status === 401 ? t('login.invalidCredentials') : errorData.message || t('login.connectionError'),
        );
      }
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/mywhatsapp_logo.webp" alt="MyWhatsapp" className="logo-icon" />
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              // ISO date (YYYYMMDD) so the format is stable across locales/regions instead of the
              // locale-dependent toLocaleDateString() which renders differently per browser region.
              date: new Date(__BUILD_TIME__).toISOString().slice(0, 10).replace(/-/g, ''),
            })}
          </span>
        </div>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          {notice && <p className="login-notice">{notice}</p>}
          <div className="input-group">
            <label htmlFor="email">{t('login.email')}</label>
            <div className="input-wrapper">
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
                autoComplete="email"
                className={error ? 'error' : ''}
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="password">{t('common.password')}</label>
            <div className="input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('common.password')}
                autoComplete="current-password"
                className={error ? 'error' : ''}
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && <span className="error-message">{error}</span>}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.signingIn') : t('login.signIn')}
          </button>
        </form>

        {onSwitch && (
          <p className="login-help">
            {t('login.signupPrompt')}{' '}
            <button type="button" className="login-switch" onClick={onSwitch}>
              {t('login.signupLink')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
