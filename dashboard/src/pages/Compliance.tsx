import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Save } from 'lucide-react';
import { organizationsApi, type QuietHoursSettings } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { PageHeader } from '../components/PageHeader';
import './Compliance.css';

/**
 * Compliance policy per organization — currently the quiet-hours window (docs/33).
 *
 * The form is deliberately an EDITOR, not a preview: the window it renders is the window the send path
 * reads, so there is nothing to preview it against. Two states are kept apart throughout, because
 * conflating them is the failure this screen can cause:
 *
 * - **never configured** (the server omits `quietHours`) — the form shows defaults and says so;
 * - **configured but paused** (`enabled: false`) — the times are real and are kept, because a merge
 *   that sent only the flag would otherwise cost the operator their window.
 *
 * Every save sends the whole window, not a diff. The server merges, so this is safe, and it means the
 * screen cannot get into the state where the form holds one window and the server another.
 */

/** ISO weekday order the API uses (Monday = 1). Deliberately not the browser's Sunday-first order. */
const WEEKDAYS = [
  { iso: 1, key: 'monday' },
  { iso: 2, key: 'tuesday' },
  { iso: 3, key: 'wednesday' },
  { iso: 4, key: 'thursday' },
  { iso: 5, key: 'friday' },
  { iso: 6, key: 'saturday' },
  { iso: 7, key: 'sunday' },
] as const;

type FormState = Required<Pick<QuietHoursSettings, 'enabled' | 'start' | 'end' | 'timezone'>> & {
  weekdays: number[];
  exemptChatIds: string;
};

/**
 * What the form shows before anything is stored.
 *
 * 22:00–07:00 rather than an empty form because a compliance screen that opens blank cannot be
 * distinguished from one that failed to load, and the default is the window most operators actually
 * want. It is a default, not a policy: nothing is stored until the operator saves.
 */
const DEFAULTS: FormState = {
  enabled: true,
  start: '22:00',
  end: '07:00',
  timezone: 'UTC',
  weekdays: [],
  exemptChatIds: '',
};

/** `Intl.supportedValuesOf` carries the runtime's IANA database, which is the same one the server uses. */
function timeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return typeof supported === 'function' ? supported('timeZone') : [DEFAULTS.timezone];
}

function toForm(stored?: QuietHoursSettings): FormState {
  return {
    enabled: stored?.enabled ?? true,
    start: stored?.start ?? DEFAULTS.start,
    end: stored?.end ?? DEFAULTS.end,
    timezone: stored?.timezone ?? DEFAULTS.timezone,
    weekdays: stored?.weekdays ?? [],
    // One address per line: the API takes an array, and a comma-separated text field would need quoting
    // rules that WhatsApp addresses (which contain `@` and `.`) make unpleasant to get right.
    exemptChatIds: (stored?.exemptChatIds ?? []).join('\n'),
  };
}

function toPayload(form: FormState): QuietHoursSettings {
  return {
    enabled: form.enabled,
    start: form.start.trim(),
    end: form.end.trim(),
    timezone: form.timezone.trim(),
    // An empty selection is stored as an empty array, which the evaluator reads as "every day" — the
    // same as omitting the key, and explicit in the audit trail rather than implied by an absent field.
    weekdays: form.weekdays,
    exemptChatIds: form.exemptChatIds
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  };
}

export function Compliance() {
  const { t } = useTranslation();
  useDocumentTitle(t('compliance.title'));
  const toast = useToast();

  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [configured, setConfigured] = useState(false);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const zones = useMemo(() => timeZones(), []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    organizationsApi
      .getSettings()
      .then(settings => {
        setForm(toForm(settings.quietHours));
        setConfigured(settings.quietHours !== undefined);
        setOrganizationId(settings.organizationId);
      })
      .catch(err => {
        // The form stays on its DEFAULTS with the error shown beside it, rather than rendering as though
        // the tenant had no window. Saving over a failed read would write the defaults over a policy that
        // exists, which is the one outcome this screen must never cause.
        setLoadError(err instanceof Error ? err.message : t('common.unknownError'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(load, [load]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const sent = toPayload(form);
    try {
      const saved = await organizationsApi.updateSettings({ quietHours: sent });
      // Adopt the server's answer rather than the local form: the merge may have kept stored values this
      // form never saw, and echoing the request back would hide them.
      setForm(toForm(saved.quietHours));
      setConfigured(saved.quietHours !== undefined);
      toast.success(t('compliance.saved'));
    } catch (err) {
      // Revert to the last known-good window. A form left showing the rejected values reads as saved.
      toast.error(t('compliance.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
      load();
    } finally {
      setSaving(false);
    }
  };

  const toggleWeekday = (iso: number) => {
    setForm(current => ({
      ...current,
      weekdays: current.weekdays.includes(iso)
        ? current.weekdays.filter(day => day !== iso)
        : [...current.weekdays, iso].sort((a, b) => a - b),
    }));
  };

  if (loading) {
    return (
      <div className="compliance">
        <PageHeader title={t('compliance.title')} subtitle={t('compliance.subtitle')} />
        <div className="compliance__loading">
          <Loader2 className="spin" size={20} /> {t('common.loading')}
        </div>
      </div>
    );
  }

  return (
    <div className="compliance">
      <PageHeader title={t('compliance.title')} subtitle={t('compliance.subtitle')} />

      {loadError && (
        <div className="compliance__error" role="alert">
          <AlertCircle size={16} /> {t('compliance.loadFailed')}: {loadError}
        </div>
      )}

      <section className="card">
        <header className="card__header">
          <h2>{t('compliance.quietHours.title')}</h2>
          {configured ? <span className="compliance__badge">{t('compliance.configured')}</span> : null}
        </header>

        <p className="compliance__hint">{t('compliance.quietHours.refuse')}</p>

        <label className="compliance__toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))}
          />
          <span>{t('compliance.quietHours.enabled')}</span>
        </label>

        <div className="compliance__grid">
          <label className="field">
            <span className="field__label">{t('compliance.quietHours.start')}</span>
            <input
              type="time"
              value={form.start}
              onChange={event => setForm(current => ({ ...current, start: event.target.value }))}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('compliance.quietHours.end')}</span>
            <input
              type="time"
              value={form.end}
              onChange={event => setForm(current => ({ ...current, end: event.target.value }))}
            />
          </label>

          <label className="field compliance__field--wide">
            <span className="field__label">{t('compliance.quietHours.timezone')}</span>
            <input
              list="compliance-timezones"
              value={form.timezone}
              onChange={event => setForm(current => ({ ...current, timezone: event.target.value }))}
            />
            <datalist id="compliance-timezones">
              {zones.map(zone => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <span className="field__hint">{t('compliance.quietHours.timezoneHint')}</span>
          </label>
        </div>

        <fieldset className="compliance__weekdays">
          <legend>{t('compliance.quietHours.weekdays')}</legend>
          {WEEKDAYS.map(day => (
            <label key={day.iso}>
              <input
                type="checkbox"
                checked={form.weekdays.includes(day.iso)}
                onChange={() => toggleWeekday(day.iso)}
              />
              <span>{t(`compliance.weekdays.${day.key}`)}</span>
            </label>
          ))}
          <span className="field__hint">{t('compliance.quietHours.weekdaysHint')}</span>
        </fieldset>

        <label className="field">
          <span className="field__label">{t('compliance.quietHours.exempt')}</span>
          <textarea
            rows={3}
            value={form.exemptChatIds}
            onChange={event => setForm(current => ({ ...current, exemptChatIds: event.target.value }))}
            placeholder="5511999999999@s.whatsapp.net"
          />
          <span className="field__hint">{t('compliance.quietHours.exemptHint')}</span>
        </label>

        <footer className="card__footer">
          <span className="compliance__org">
            {t('compliance.organization')}: {organizationId || '—'}
          </span>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            {t('compliance.save')}
          </button>
        </footer>
      </section>
    </div>
  );
}
