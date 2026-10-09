import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import './Login.css';

interface SignupProps {
  /** Called with the newly-signed-up email on success — App switches back to the login view and pre-fills it. */
  onSignup: (email: string) => void;
  /** Switch back to the login view. */
  onSwitch: () => void;
}

export function Signup({ onSignup, onSwitch }: SignupProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError(t('login.emailRequired'));
      return;
    }
    if (!password) {
      setError(t('login.passwordRequired'));
      return;
    }
    if (password.length < 8) {
      setError(t('signup.passwordTooShort'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });

      if (response.ok) {
        onSignup(trimmedEmail);
      } else {
        const errorData = await response.json().catch(() => ({}));
        // 409 is always "this email is taken"; 429 the create bucket; anything else (400 validation,
        // 5xx) surfaces the server's detail when it offers one.
        setError(
          response.status === 409
            ? t('signup.accountExists')
            : response.status === 429
              ? t('signup.tooManyRequests')
              : errorData.message || t('login.connectionError'),
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

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          <div className="input-group">
            <label htmlFor="signup-name">{t('signup.name')}</label>
            <div className="input-wrapper">
              <input
                id="signup-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('signup.namePlaceholder')}
                autoComplete="name"
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="signup-email">{t('login.email')}</label>
            <div className="input-wrapper">
              <input
                id="signup-email"
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
            <label htmlFor="signup-password">{t('common.password')}</label>
            <div className="input-wrapper">
              <input
                id="signup-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('common.password')}
                autoComplete="new-password"
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
            {isLoading ? t('signup.signingUp') : t('signup.signUp')}
          </button>
        </form>

        <p className="login-help">
          {t('signup.loginPrompt')}{' '}
          <button type="button" className="login-switch" onClick={onSwitch}>
            {t('signup.loginLink')}
          </button>
        </p>
      </div>
    </div>
  );
}
