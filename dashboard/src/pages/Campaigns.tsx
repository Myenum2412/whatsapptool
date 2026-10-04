import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Download,
  FileSpreadsheet,
  Loader2,
  Link2,
  BarChart3,
  ListOrdered,
  Paperclip,
  Pause,
  Play,
  Plus,
  Send,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  campaignApi,
  type Campaign,
  type CampaignAttachmentScope,
  type CampaignDetail,
  type CampaignRecipientFilter,
  type CampaignResponseStyle,
  type CampaignMediaType,
  type CampaignRecipientStatus,
  type SpreadsheetInspection,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useCampaignActionMutation,
  useCampaignQuery,
  useCampaignRecipientsQuery,
  useCampaignsQuery,
  useCreateCampaignMutation,
  useInvalidateCampaigns,
  useSessionsQuery,
  useTemplatesQuery,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Campaigns.css';

// Mirrors the gateway's CAMPAIGN_UPLOAD_MAX_BYTES default; the server is the authority, this only
// stops an obviously wrong pick (a video, a zip of photos) before it is uploaded.
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Mirrors the gateway's MEDIA_DOWNLOAD_MAX_BYTES default for one attachment.
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Same matching rule as the gateway: last path segment, trimmed, lower-cased. */
const normalizeFileName = (name: string): string => (name.trim().split(/[\\/]/).pop() ?? '').trim().toLowerCase();

const isLink = (value: string): boolean => /^https?:\/\//i.test(value.trim());

/**
 * Upload files to a campaign one request at a time, reporting progress. Returns the failures so the
 * caller can say which files did not make it; the rest are already stored.
 */
async function uploadAll(
  sessionId: string,
  campaignId: string,
  jobs: Array<{ file: File; scope: CampaignAttachmentScope }>,
  onProgress: (done: number, total: number) => void,
): Promise<Array<{ name: string; error: string }>> {
  const failures: Array<{ name: string; error: string }> = [];
  for (const [i, job] of jobs.entries()) {
    onProgress(i, jobs.length);
    try {
      await campaignApi.uploadAttachment(sessionId, campaignId, job.file, job.scope);
    } catch (error) {
      failures.push({ name: job.file.name, error: errorMessage(error) });
    }
  }
  onProgress(jobs.length, jobs.length);
  return failures;
}

const placeholdersIn = (...texts: (string | null | undefined)[]): string[] => [
  ...new Set(texts.flatMap(text => Array.from((text ?? '').matchAll(PLACEHOLDER_PATTERN), m => m[1]))),
];

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type WizardForm = {
  name: string;
  source: 'template' | 'custom';
  templateId: string;
  body: string;
  phoneColumn: string;
  mediaColumn: string;
  mediaType: CampaignMediaType;
  sharedFiles: File[];
  rowFiles: File[];
  askResponse: boolean;
  responseStyle: CampaignResponseStyle;
  responseQuestion: string;
  responseOptions: string[];
  responseMultiple: boolean;
  defaultCountryCode: string;
  delaySeconds: string;
  skipRowsWithMissingValues: boolean;
};

export function Campaigns() {
  const { t } = useTranslation();
  useDocumentTitle(t('campaigns.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [sessionId, setSessionId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!sessionId && sessions.length > 0) setSessionId(sessions[0].id);
  }, [sessionId, sessions]);

  const { data: campaigns = [], isLoading: loadingCampaigns, error: campaignsError } = useCampaignsQuery(sessionId);

  if (loadingSessions) {
    return (
      <div className="campaigns-page campaigns-center">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="campaigns-page">
      <PageHeader
        title={t('campaigns.title')}
        subtitle={t('campaigns.subtitle')}
        actions={
          <>
            <select
              className="campaigns-session-select"
              aria-label={t('campaigns.sessionSelect')}
              value={sessionId}
              onChange={event => {
                setSessionId(event.target.value);
                setSelectedId(null);
                setCreating(false);
              }}
            >
              {sessions.length === 0 && <option value="">{t('campaigns.noSessions')}</option>}
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
            <button
              className="btn-primary"
              disabled={!canWrite || !sessionId}
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
              }}
            >
              <Plus size={18} />
              {t('campaigns.new')}
            </button>
          </>
        }
      />

      {sessions.length === 0 ? (
        <div className="campaigns-center campaigns-empty">
          <FileSpreadsheet size={48} strokeWidth={1} />
          <p>{t('campaigns.noSessions')}</p>
        </div>
      ) : (
        <div className="campaigns-workspace">
          <aside className="campaigns-list">
            {loadingCampaigns && (
              <div className="campaigns-center campaigns-list-note">
                <Loader2 className="animate-spin" size={20} />
              </div>
            )}
            {campaignsError && (
              <div className="campaigns-list-note campaigns-error" role="alert">
                {errorMessage(campaignsError)}
              </div>
            )}
            {!loadingCampaigns && !campaignsError && campaigns.length === 0 && (
              <div className="campaigns-list-note">{t('campaigns.empty')}</div>
            )}
            {campaigns.map(campaign => (
              <CampaignListItem
                key={campaign.id}
                campaign={campaign}
                active={campaign.id === selectedId && !creating}
                onSelect={() => {
                  setSelectedId(campaign.id);
                  setCreating(false);
                }}
              />
            ))}
          </aside>

          <section className="campaigns-main">
            {creating ? (
              <NewCampaignWizard
                sessionId={sessionId}
                onCancel={() => setCreating(false)}
                onCreated={id => {
                  setCreating(false);
                  setSelectedId(id);
                }}
              />
            ) : selectedId ? (
              <CampaignDetailPanel sessionId={sessionId} id={selectedId} onDeleted={() => setSelectedId(null)} />
            ) : (
              <div className="campaigns-center campaigns-empty">
                <Send size={40} strokeWidth={1} />
                <p>{t('campaigns.pickOrCreate')}</p>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ campaign }: { campaign: Pick<Campaign, 'status'> }) {
  const { t } = useTranslation();
  return (
    <span className={`campaigns-badge campaigns-badge--${campaign.status}`}>
      {t(`campaigns.status.${campaign.status}`)}
    </span>
  );
}

function ProgressBar({ campaign }: { campaign: Pick<Campaign, 'progress'> }) {
  const { total, sent, failed, skipped } = campaign.progress;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="campaigns-progress" aria-hidden="true">
      <span className="campaigns-progress-sent" style={{ width: `${pct(sent)}%` }} />
      <span className="campaigns-progress-failed" style={{ width: `${pct(failed)}%` }} />
      <span className="campaigns-progress-skipped" style={{ width: `${pct(skipped)}%` }} />
    </div>
  );
}

function CampaignListItem({
  campaign,
  active,
  onSelect,
}: {
  campaign: Campaign;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button className={`campaigns-list-item${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="campaigns-list-title">
        {campaign.name}
        <StatusBadge campaign={campaign} />
      </span>
      <ProgressBar campaign={campaign} />
      <span className="campaigns-list-meta">
        {t('campaigns.progressLine', {
          sent: campaign.progress.sent,
          total: campaign.progress.total - campaign.progress.skipped,
        })}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// New campaign
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function NewCampaignWizard({
  sessionId,
  onCancel,
  onCreated,
}: {
  sessionId: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const { data: templates = [] } = useTemplatesQuery(sessionId);
  const createMutation = useCreateCampaignMutation();
  const invalidateCampaigns = useInvalidateCampaigns();
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState<SpreadsheetInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [form, setForm] = useState<WizardForm>({
    name: '',
    source: 'custom',
    templateId: '',
    body: '',
    phoneColumn: '',
    mediaColumn: '',
    mediaType: 'auto',
    sharedFiles: [],
    rowFiles: [],
    askResponse: false,
    responseStyle: 'poll',
    responseQuestion: '',
    responseOptions: ['Interested', 'Not interested'],
    responseMultiple: false,
    defaultCountryCode: '',
    delaySeconds: '5',
    skipRowsWithMissingValues: true,
  });
  const update = (patch: Partial<WizardForm>) => setForm(current => ({ ...current, ...patch }));

  const template = templates.find(tpl => tpl.id === form.templateId);
  const messageParts =
    form.source === 'template' && template ? [template.header, template.body, template.footer] : [form.body];
  const placeholders = placeholdersIn(...messageParts, form.askResponse ? form.responseQuestion : '');
  const responseError = form.askResponse ? validateOptions(form) : null;
  const columnKeys = new Set(sheet?.columns.map(c => c.key));
  const unknownPlaceholders = placeholders.filter(key => !columnKeys.has(key));
  const delaySeconds = Number(form.delaySeconds);
  const delayValid = Number.isFinite(delaySeconds) && delaySeconds >= 1 && delaySeconds <= 600;
  const hasMessage = form.source === 'template' ? !!template : form.body.trim().length > 0;
  const canSubmit =
    !!file &&
    !!sheet &&
    form.name.trim().length > 0 &&
    !!form.phoneColumn &&
    hasMessage &&
    unknownPlaceholders.length === 0 &&
    !responseError &&
    delayValid &&
    !createMutation.isPending &&
    !uploading;

  // Which sample rows' attachment cells will find a file (the full check runs on the server).
  const rowFileNames = new Set(form.rowFiles.map(f => normalizeFileName(f.name)));
  const sampleMatches = form.mediaColumn
    ? (sheet?.sampleRows ?? []).map(row => {
        const cell = (row[form.mediaColumn] ?? '').trim();
        const state: 'none' | 'link' | 'matched' | 'missing' = !cell
          ? 'none'
          : isLink(cell)
            ? 'link'
            : rowFileNames.has(normalizeFileName(cell))
              ? 'matched'
              : 'missing';
        return { cell, state };
      })
    : [];

  const addFiles = (key: 'sharedFiles' | 'rowFiles', picked: FileList | null) => {
    const list = Array.from(picked ?? []);
    const tooBig = list.filter(f => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig.length > 0)
      toast.error(t('campaigns.attachments.tooLarge', { names: tooBig.map(f => f.name).join(', ') }));
    const ok = list.filter(f => f.size <= ATTACHMENT_MAX_BYTES);
    setForm(current => {
      const taken = new Set([...current.sharedFiles, ...current.rowFiles].map(f => normalizeFileName(f.name)));
      return { ...current, [key]: [...current[key], ...ok.filter(f => !taken.has(normalizeFileName(f.name)))] };
    });
  };
  const dropFile = (key: 'sharedFiles' | 'rowFiles', index: number) =>
    setForm(current => ({ ...current, [key]: current[key].filter((_, i) => i !== index) }));

  const firstRow = sheet?.sampleRows[0];
  const samplePreview = firstRow
    ? messageParts
        .filter((part): part is string => !!part)
        .map(part => part.replace(PLACEHOLDER_PATTERN, (match, key: string) => firstRow[key] ?? match))
        .join('\n\n')
    : '';
  const fillRow = (text: string): string =>
    firstRow ? text.replace(PLACEHOLDER_PATTERN, (match, key: string) => firstRow[key] ?? match) : text;
  const previewText =
    form.askResponse && form.responseStyle === 'reply'
      ? [samplePreview, replyBlock(fillRow(form.responseQuestion), cleanOptions(form.responseOptions))]
          .filter(Boolean)
          .join('\n\n')
      : samplePreview;

  const pickFile = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > UPLOAD_MAX_BYTES) {
      toast.error(t('campaigns.wizard.fileTooLarge'));
      return;
    }
    setInspecting(true);
    try {
      const result = await campaignApi.inspect(sessionId, picked);
      setFile(picked);
      setSheet(result);
      update({
        phoneColumn: result.suggestedPhoneColumn
          ? (result.columns.find(c => c.header === result.suggestedPhoneColumn)?.key ?? '')
          : '',
        name: form.name || picked.name.replace(/\.(xlsx|csv)$/i, ''),
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setInspecting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const insertPlaceholder = (key: string) => {
    const token = `{{${key}}}`;
    const el = bodyInput.current;
    if (!el) {
      update({ body: form.body + token });
      return;
    }
    const start = el.selectionStart ?? form.body.length;
    const end = el.selectionEnd ?? form.body.length;
    update({ body: form.body.slice(0, start) + token + form.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async () => {
    if (!file || !canSubmit) return;
    try {
      const created = await createMutation.mutateAsync({
        sessionId,
        file,
        data: {
          name: form.name.trim(),
          ...(form.source === 'template' ? { templateId: form.templateId } : { body: form.body }),
          phoneColumn: form.phoneColumn,
          ...(form.mediaColumn ? { mediaColumn: form.mediaColumn } : {}),
          mediaType: form.mediaType,
          ...(form.defaultCountryCode.trim() ? { defaultCountryCode: form.defaultCountryCode.trim() } : {}),
          ...(form.askResponse
            ? {
                responseStyle: form.responseStyle,
                responseQuestion: form.responseQuestion.trim(),
                responseOptions: cleanOptions(form.responseOptions),
                responseMultiple: form.responseMultiple,
              }
            : {}),
          delayMs: Math.round(delaySeconds * 1000),
          skipRowsWithMissingValues: form.skipRowsWithMissingValues,
        },
      });
      const jobs = [
        ...form.sharedFiles.map(f => ({ file: f, scope: 'all' as const })),
        ...(form.mediaColumn ? form.rowFiles.map(f => ({ file: f, scope: 'row' as const })) : []),
      ];
      if (jobs.length > 0) {
        const failures = await uploadAll(sessionId, created.id, jobs, (done, total) => setUploading({ done, total }));
        setUploading(null);
        await invalidateCampaigns(sessionId);
        if (failures.length > 0) {
          toast.error(
            t('campaigns.attachments.someFailed', {
              list: failures.map(f => `${f.name} (${f.error})`).join('; '),
            }),
          );
        }
      }
      toast.success(t('campaigns.toasts.created', { count: created.progress.pending }));
      onCreated(created.id);
    } catch (error) {
      setUploading(null);
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="campaigns-wizard">
      <h2>{t('campaigns.wizard.title')}</h2>

      <div className="campaigns-warning" role="note">
        <AlertTriangle size={18} />
        <p>{t('campaigns.wizard.banWarning')}</p>
      </div>

      {/* Step 1: spreadsheet */}
      <div className="campaigns-step">
        <h3>{t('campaigns.wizard.step1')}</h3>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: 'none' }}
          onChange={event => void pickFile(event.target.files?.[0])}
        />
        <button className="btn-secondary" onClick={() => fileInput.current?.click()} disabled={inspecting}>
          {inspecting ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
          {file ? t('campaigns.wizard.replaceFile') : t('campaigns.wizard.chooseFile')}
        </button>
        <p className="campaigns-hint">{t('campaigns.wizard.fileHint')}</p>
        {sheet && file && (
          <>
            <p className="campaigns-file-summary">
              <FileSpreadsheet size={16} />
              {t('campaigns.wizard.fileSummary', {
                name: file.name,
                rows: sheet.rowCount,
                columns: sheet.columns.length,
              })}
            </p>
            <div className="campaigns-table-wrap">
              <table className="campaigns-table">
                <thead>
                  <tr>
                    {sheet.columns.map(column => (
                      <th key={column.key}>
                        {column.header}
                        <code>{`{{${column.key}}}`}</code>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.sampleRows.map((row, i) => (
                    <tr key={i}>
                      {sheet.columns.map(column => (
                        <td key={column.key}>{row[column.key]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {sheet && (
        <>
          {/* Step 2: recipients */}
          <div className="campaigns-step">
            <h3>{t('campaigns.wizard.step2')}</h3>
            <div className="campaigns-grid">
              <label className="form-group">
                <span>{t('campaigns.wizard.name')}</span>
                <input value={form.name} maxLength={100} onChange={e => update({ name: e.target.value })} />
              </label>
              <label className="form-group">
                <span>{t('campaigns.wizard.phoneColumn')}</span>
                <select value={form.phoneColumn} onChange={e => update({ phoneColumn: e.target.value })}>
                  <option value="">{t('campaigns.wizard.selectColumn')}</option>
                  {sheet.columns.map(column => (
                    <option key={column.key} value={column.key}>
                      {column.header}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-group">
                <span>{t('campaigns.wizard.countryCode')}</span>
                <input
                  value={form.defaultCountryCode}
                  placeholder="91"
                  inputMode="numeric"
                  maxLength={5}
                  onChange={e => update({ defaultCountryCode: e.target.value.replace(/[^0-9+]/g, '') })}
                />
                <small>{t('campaigns.wizard.countryCodeHint')}</small>
              </label>
            </div>
          </div>

          {/* Step 3: message */}
          <div className="campaigns-step">
            <h3>{t('campaigns.wizard.step3')}</h3>
            <div className="campaigns-source-toggle" role="radiogroup">
              <label>
                <input type="radio" checked={form.source === 'custom'} onChange={() => update({ source: 'custom' })} />
                {t('campaigns.wizard.sourceCustom')}
              </label>
              <label>
                <input
                  type="radio"
                  checked={form.source === 'template'}
                  onChange={() => update({ source: 'template' })}
                  disabled={templates.length === 0}
                />
                {t('campaigns.wizard.sourceTemplate')}
              </label>
            </div>

            {form.source === 'template' ? (
              <label className="form-group">
                <span>{t('campaigns.wizard.template')}</span>
                <select value={form.templateId} onChange={e => update({ templateId: e.target.value })}>
                  <option value="">{t('campaigns.wizard.selectTemplate')}</option>
                  {templates.map(tpl => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="form-group">
                <label htmlFor="campaign-body">{t('campaigns.wizard.body')}</label>
                <textarea
                  id="campaign-body"
                  ref={bodyInput}
                  rows={6}
                  maxLength={4096}
                  value={form.body}
                  placeholder={t('campaigns.wizard.bodyPlaceholder')}
                  onChange={e => update({ body: e.target.value })}
                />
                <div className="campaigns-chips">
                  <small>{t('campaigns.wizard.insertColumn')}</small>
                  {sheet.columns.map(column => (
                    <button
                      key={column.key}
                      type="button"
                      className="campaigns-chip"
                      onClick={() => insertPlaceholder(column.key)}
                    >
                      {column.header}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {unknownPlaceholders.length > 0 && (
              <div className="campaigns-error" role="alert">
                {t('campaigns.wizard.unknownPlaceholders', {
                  list: unknownPlaceholders.map(k => `{{${k}}}`).join(', '),
                })}
              </div>
            )}

            <ResponseOptionsEditor form={form} update={update} error={responseError} />

            {(previewText || (form.askResponse && form.responseStyle === 'poll')) && (
              <div className="campaigns-bubble-wrap">
                <small>{t('campaigns.wizard.previewFirstRow')}</small>
                {previewText && <div className="campaigns-bubble">{previewText}</div>}
                {form.askResponse && form.responseStyle === 'poll' && (
                  <PollMock
                    question={fillRow(form.responseQuestion)}
                    options={cleanOptions(form.responseOptions)}
                    multiple={form.responseMultiple}
                  />
                )}
              </div>
            )}
          </div>

          {/* Step 4: attachments */}
          <div className="campaigns-step">
            <h3>{t('campaigns.wizard.step4')}</h3>

            <div className="campaigns-attach-block">
              <strong>{t('campaigns.attachments.sharedTitle')}</strong>
              <small>{t('campaigns.attachments.sharedHint')}</small>
              <FilePickerButton
                label={t('campaigns.attachments.addShared')}
                onPick={files => addFiles('sharedFiles', files)}
              />
              <PendingFileList files={form.sharedFiles} onRemove={i => dropFile('sharedFiles', i)} />
            </div>

            <div className="campaigns-attach-block">
              <strong>{t('campaigns.attachments.rowTitle')}</strong>
              <small>{t('campaigns.attachments.rowHint')}</small>
              <label className="form-group">
                <span>{t('campaigns.wizard.mediaColumn')}</span>
                <select value={form.mediaColumn} onChange={e => update({ mediaColumn: e.target.value })}>
                  <option value="">{t('campaigns.wizard.noMedia')}</option>
                  {sheet.columns.map(column => (
                    <option key={column.key} value={column.key}>
                      {column.header}
                    </option>
                  ))}
                </select>
              </label>
              {form.mediaColumn && (
                <>
                  <FilePickerButton
                    label={t('campaigns.attachments.addRow')}
                    onPick={files => addFiles('rowFiles', files)}
                  />
                  <PendingFileList files={form.rowFiles} onRemove={i => dropFile('rowFiles', i)} />
                  {sampleMatches.length > 0 && (
                    <ul className="campaigns-match-list" aria-label={t('campaigns.attachments.sampleCheck')}>
                      {sampleMatches.map((m, i) => (
                        <li key={i} className={`campaigns-match campaigns-match--${m.state}`}>
                          {t(`campaigns.attachments.match.${m.state}`, { name: m.cell })}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>

            <label className="campaigns-checkbox">
              <input
                type="checkbox"
                checked={form.mediaType === 'document'}
                onChange={e => update({ mediaType: e.target.checked ? 'document' : 'auto' })}
              />
              {t('campaigns.attachments.asDocument')}
            </label>
          </div>

          {/* Step 5: pacing */}
          <div className="campaigns-step">
            <h3>{t('campaigns.wizard.step5')}</h3>
            <div className="campaigns-grid">
              <label className="form-group">
                <span>{t('campaigns.wizard.delay')}</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={form.delaySeconds}
                  onChange={e => update({ delaySeconds: e.target.value })}
                />
                <small>{t('campaigns.wizard.delayHint')}</small>
              </label>
            </div>
            <label className="campaigns-checkbox">
              <input
                type="checkbox"
                checked={form.skipRowsWithMissingValues}
                onChange={e => update({ skipRowsWithMissingValues: e.target.checked })}
              />
              {t('campaigns.wizard.skipMissing')}
            </label>
          </div>
        </>
      )}

      <div className="campaigns-actions">
        <button className="btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
          {createMutation.isPending || uploading ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <FileSpreadsheet size={18} />
          )}
          {uploading
            ? t('campaigns.attachments.uploading', { done: uploading.done, total: uploading.total })
            : t('campaigns.wizard.createDraft')}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Campaign detail
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const RECIPIENT_FILTERS: Array<CampaignRecipientStatus | ''> = ['', 'pending', 'sent', 'failed', 'skipped'];

type RecipientFilterChoice = { key: string; label: string; filter: CampaignRecipientFilter };

function CampaignDetailPanel({ sessionId, id, onDeleted }: { sessionId: string; id: string; onDeleted: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { canWrite } = useRole();
  const [filterKey, setFilterKey] = useState('all');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState<'start' | 'cancel' | 'delete' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const { data: campaign, isLoading, error } = useCampaignQuery(sessionId, id);
  const live = campaign?.status === 'running';
  const filterChoices: RecipientFilterChoice[] = [
    ...RECIPIENT_FILTERS.map(status => ({
      key: status || 'all',
      label: status ? t(`campaigns.recipientStatus.${status}`) : t('campaigns.all'),
      filter: status ? { status } : {},
    })),
    ...(campaign?.responseOptions ?? []).map(option => ({
      key: `response:${option}`,
      label: `✓ ${option}`,
      filter: { response: option },
    })),
    ...(campaign?.responseOptions
      ? [{ key: 'responded:no', label: t('campaigns.responses.noAnswer'), filter: { responded: 'no' as const } }]
      : []),
  ];
  const activeFilter = filterChoices.find(choice => choice.key === filterKey) ?? filterChoices[0];
  const { data: recipients } = useCampaignRecipientsQuery(
    sessionId,
    id,
    activeFilter.filter,
    page,
    live || (!!campaign?.responseOptions && campaign.status !== 'draft'),
  );
  const action = useCampaignActionMutation();

  useEffect(() => {
    setFilterKey('all');
    setPage(1);
  }, [id]);

  if (isLoading) {
    return (
      <div className="campaigns-center">
        <Loader2 className="animate-spin" size={28} />
      </div>
    );
  }
  if (error || !campaign) {
    return (
      <div className="campaigns-error" role="alert">
        {errorMessage(error)}
      </div>
    );
  }

  const run = async (kind: 'start' | 'pause' | 'cancel' | 'delete') => {
    setConfirm(null);
    try {
      await action.mutateAsync({ sessionId, id, action: kind });
      toast.success(t(`campaigns.toasts.${kind}`));
      if (kind === 'delete') onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await campaignApi.exportResults(sessionId, id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${campaign.name.replace(/[^\w.-]+/g, '_') || 'campaign'}-results.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const { progress } = campaign;
  const canStart = campaign.status === 'draft' || campaign.status === 'paused';
  const finished = campaign.status === 'completed' || campaign.status === 'cancelled';
  const totalPages = recipients ? Math.max(1, Math.ceil(recipients.total / recipients.limit)) : 1;

  return (
    <div className="campaigns-detail">
      <div className="campaigns-detail-header">
        <div>
          <h2>
            {campaign.name} <StatusBadge campaign={campaign} />
          </h2>
          {campaign.sourceFilename && <p className="campaigns-hint">{campaign.sourceFilename}</p>}
        </div>
        <div className="campaigns-detail-actions">
          {canStart && (
            <button
              className="btn-primary"
              disabled={!canWrite || action.isPending}
              onClick={() => setConfirm('start')}
            >
              <Play size={16} />
              {campaign.status === 'draft' ? t('campaigns.actions.start') : t('campaigns.actions.resume')}
            </button>
          )}
          {campaign.status === 'running' && (
            <button
              className="btn-secondary"
              disabled={!canWrite || action.isPending}
              onClick={() => void run('pause')}
            >
              <Pause size={16} />
              {t('campaigns.actions.pause')}
            </button>
          )}
          {!finished && (
            <button
              className="btn-secondary"
              disabled={!canWrite || action.isPending}
              onClick={() => setConfirm('cancel')}
            >
              <XCircle size={16} />
              {t('campaigns.actions.cancel')}
            </button>
          )}
          <button className="btn-secondary" disabled={downloading} onClick={() => void download()}>
            {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {t('campaigns.actions.export')}
          </button>
          {campaign.status !== 'running' && (
            <button
              className="icon-btn danger"
              aria-label={t('common.delete')}
              disabled={!canWrite || action.isPending}
              onClick={() => setConfirm('delete')}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {campaign.status === 'paused' && campaign.pauseReason && campaign.pauseReason !== 'MANUAL' && (
        <div className="campaigns-warning" role="status">
          <AlertTriangle size={18} />
          <p>{t(`campaigns.pauseReasons.${campaign.pauseReason}`)}</p>
        </div>
      )}

      <div className="campaigns-stats">
        {(['total', 'pending', 'sent', 'failed', 'skipped'] as const).map(key => (
          <div key={key} className={`campaigns-stat campaigns-stat--${key}`}>
            <span>{t(`campaigns.progress.${key}`)}</span>
            <strong>{progress[key]}</strong>
          </div>
        ))}
      </div>
      <ProgressBar campaign={campaign} />

      {Object.keys(campaign.skippedByReason).length > 0 && (
        <p className="campaigns-hint">
          {t('campaigns.skippedSummary')}{' '}
          {Object.entries(campaign.skippedByReason)
            .map(([reason, n]) => `${t(`campaigns.skipReasons.${reason}`, { defaultValue: reason })}: ${n}`)
            .join(' · ')}
        </p>
      )}

      {campaign.responseSummary && (
        <ResponsesSection
          campaign={campaign}
          onPick={key => {
            setFilterKey(key);
            setPage(1);
          }}
        />
      )}

      <AttachmentsSection sessionId={sessionId} campaign={campaign} canEdit={canWrite && campaign.status === 'draft'} />

      {campaign.preview.length > 0 && (
        <div className="campaigns-step">
          <h3>{t('campaigns.nextMessages')}</h3>
          <div className="campaigns-preview-list">
            {campaign.preview.map(item => (
              <div key={item.rowNumber} className="campaigns-bubble-wrap">
                <small>
                  {t('campaigns.rowTo', { row: item.rowNumber, chatId: item.chatId.replace(/@c\.us$/, '') })}
                </small>
                {item.attachments.length > 0 && (
                  <div className="campaigns-bubble-files">
                    {item.attachments.map(name => (
                      <span key={name}>
                        <Paperclip size={12} /> {name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="campaigns-bubble">{item.text}</div>
                {item.poll && (
                  <PollMock
                    question={item.poll.question}
                    options={item.poll.options}
                    multiple={campaign.responseMultiple}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="campaigns-step">
        <div className="campaigns-filter" role="tablist">
          {filterChoices.map(choice => (
            <button
              key={choice.key}
              role="tab"
              aria-selected={activeFilter.key === choice.key}
              className={activeFilter.key === choice.key ? 'active' : ''}
              onClick={() => {
                setFilterKey(choice.key);
                setPage(1);
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <div className="campaigns-table-wrap">
          <table className="campaigns-table">
            <thead>
              <tr>
                <th>{t('campaigns.table.row')}</th>
                <th>{t('campaigns.table.phone')}</th>
                <th>{t('campaigns.table.status')}</th>
                {campaign.responseOptions && <th>{t('campaigns.table.response')}</th>}
                <th>{t('campaigns.table.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {recipients?.items.map(row => (
                <tr key={row.id}>
                  <td>{row.rowNumber}</td>
                  <td>{row.chatId?.replace(/@c\.us$/, '') ?? row.variables[campaign.phoneColumn] ?? '—'}</td>
                  <td>
                    <span className={`campaigns-dot campaigns-dot--${row.status}`} />
                    {t(`campaigns.recipientStatus.${row.status}`)}
                  </td>
                  {campaign.responseOptions && (
                    <td className="campaigns-cell-response">
                      {row.response?.length ? (
                        <span title={row.respondedAt ? new Date(row.respondedAt).toLocaleString() : undefined}>
                          {row.response.join(', ')}
                          <small> · {t(`campaigns.responses.via.${row.responseVia ?? 'poll'}`)}</small>
                        </span>
                      ) : (
                        <span className="campaigns-muted">—</span>
                      )}
                    </td>
                  )}
                  <td className="campaigns-cell-detail">
                    {row.errorMessage ?? (row.sentAt ? new Date(row.sentAt).toLocaleString() : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="campaigns-pager">
            <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              ‹
            </button>
            <span>{t('campaigns.pageOf', { page, total: totalPages })}</span>
            <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              ›
            </button>
          </div>
        )}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? t(`campaigns.confirm.${confirm}Title`) : ''}
        closeLabel={t('common.close')}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
            <button
              className={confirm === 'start' ? 'btn-primary' : 'btn-danger'}
              onClick={() => confirm && void run(confirm)}
            >
              {confirm ? t(`campaigns.confirm.${confirm}Button`) : ''}
            </button>
          </>
        }
      >
        <p>{confirm ? t(`campaigns.confirm.${confirm}Body`, { count: progress.pending }) : ''}</p>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function FilePickerButton({ label, onPick }: { label: string; onPick: (files: FileList | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={event => {
          onPick(event.target.files);
          event.target.value = '';
        }}
      />
      <button type="button" className="btn-secondary campaigns-pick" onClick={() => input.current?.click()}>
        <Paperclip size={16} />
        {label}
      </button>
    </>
  );
}

function PendingFileList({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const { t } = useTranslation();
  if (files.length === 0) return null;
  return (
    <ul className="campaigns-file-list">
      {files.map((file, i) => (
        <li key={`${file.name}-${i}`}>
          <span className="campaigns-file-name">{file.name}</span>
          <span className="campaigns-file-meta">{formatBytes(file.size)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('campaigns.attachments.remove', { name: file.name })}
            onClick={() => onRemove(i)}
          >
            <XCircle size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The campaign's stored files; on a draft they can still be added or removed. */
function AttachmentsSection({
  sessionId,
  campaign,
  canEdit,
}: {
  sessionId: string;
  campaign: CampaignDetail;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const invalidateCampaigns = useInvalidateCampaigns();
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  if (campaign.attachments.length === 0 && !campaign.mediaColumn && !canEdit) return null;

  const upload = async (files: FileList | null, scope: CampaignAttachmentScope) => {
    const list = Array.from(files ?? []);
    const tooBig = list.filter(f => f.size > ATTACHMENT_MAX_BYTES);
    if (tooBig.length > 0)
      toast.error(t('campaigns.attachments.tooLarge', { names: tooBig.map(f => f.name).join(', ') }));
    const jobs = list.filter(f => f.size <= ATTACHMENT_MAX_BYTES).map(file => ({ file, scope }));
    if (jobs.length === 0) return;
    const failures = await uploadAll(sessionId, campaign.id, jobs, (done, total) => setUploading({ done, total }));
    setUploading(null);
    await invalidateCampaigns(sessionId);
    if (failures.length > 0) {
      toast.error(
        t('campaigns.attachments.someFailed', { list: failures.map(f => `${f.name} (${f.error})`).join('; ') }),
      );
    } else {
      toast.success(t('campaigns.attachments.uploaded', { count: jobs.length }));
    }
  };

  const remove = async (attachmentId: string) => {
    setRemoving(attachmentId);
    try {
      await campaignApi.removeAttachment(sessionId, campaign.id, attachmentId);
      await invalidateCampaigns(sessionId);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRemoving(null);
    }
  };

  const shared = campaign.attachments.filter(a => a.scope === 'all');
  const perRow = campaign.attachments.filter(a => a.scope === 'row');
  const column = campaign.columns.find(c => c.key === campaign.mediaColumn)?.header;

  const renderList = (items: CampaignDetail['attachments']) => (
    <ul className="campaigns-file-list">
      {items.map(a => (
        <li key={a.id}>
          <span className="campaigns-file-name">{a.filename}</span>
          <span className="campaigns-file-meta">
            {formatBytes(a.sizeBytes)} · {t(`campaigns.attachments.sendAs.${a.sendAs}`)}
          </span>
          {canEdit && (
            <button
              type="button"
              className="icon-btn danger"
              aria-label={t('campaigns.attachments.remove', { name: a.filename })}
              disabled={removing === a.id}
              onClick={() => void remove(a.id)}
            >
              {removing === a.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="campaigns-step">
      <h3>{t('campaigns.attachments.title')}</h3>
      {uploading && (
        <p className="campaigns-hint" role="status">
          <Loader2 size={14} className="animate-spin" />{' '}
          {t('campaigns.attachments.uploading', { done: uploading.done, total: uploading.total })}
        </p>
      )}

      <div className="campaigns-attach-block">
        <strong>{t('campaigns.attachments.sharedTitle')}</strong>
        {shared.length > 0 ? renderList(shared) : <small>{t('campaigns.attachments.none')}</small>}
        {canEdit && (
          <FilePickerButton label={t('campaigns.attachments.addShared')} onPick={files => void upload(files, 'all')} />
        )}
      </div>

      {campaign.mediaColumn && (
        <div className="campaigns-attach-block">
          <strong>{t('campaigns.attachments.rowTitleFor', { column })}</strong>
          {perRow.length > 0 && renderList(perRow)}
          {campaign.missingAttachments.length > 0 && (
            <div className="campaigns-warning" role="status">
              <Link2 size={18} />
              <p>
                {t('campaigns.attachments.missing', {
                  count: campaign.skippedByReason.MISSING_ATTACHMENT ?? 0,
                  list: campaign.missingAttachments.join(', '),
                })}
              </p>
            </div>
          )}
          {canEdit && (
            <FilePickerButton label={t('campaigns.attachments.addRow')} onPick={files => void upload(files, 'row')} />
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Response options
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// WhatsApp caps a poll at 12 options; a numbered list has no cap, but past 20 nobody reads it.
const OPTION_LIMITS: Record<CampaignResponseStyle, number> = { poll: 12, reply: 20 };
const OPTION_MAX_CHARS = 100;

const cleanOptions = (options: string[]): string[] => options.map(o => o.trim()).filter(Boolean);

const replyBlock = (question: string, options: string[]): string =>
  [question.trim(), ...options.map((o, i) => `${i + 1}. ${o}`)].filter(Boolean).join('\n');

/** Mirrors the gateway's checks so the button stays disabled until the server would accept it. */
function validateOptions(form: WizardForm): string | null {
  const options = form.responseOptions.map(o => o.trim());
  if (options.some(o => !o)) return 'empty';
  if (options.length < 2) return 'tooFew';
  if (options.length > OPTION_LIMITS[form.responseStyle]) return 'tooMany';
  if (options.some(o => o.length > OPTION_MAX_CHARS)) return 'tooLong';
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) return 'duplicate';
  if (form.responseStyle === 'reply' && options.some(o => /^\d+$/.test(o))) return 'numeric';
  if (form.responseStyle === 'poll' && !form.responseQuestion.trim()) return 'noQuestion';
  return null;
}

const PRESETS: Array<{ key: string; options: string[] }> = [
  { key: 'interested', options: ['Interested', 'Not interested'] },
  { key: 'yesNo', options: ['Yes', 'No'] },
  { key: 'yesNoMaybe', options: ['Yes', 'No', 'Maybe'] },
];

function ResponseOptionsEditor({
  form,
  update,
  error,
}: {
  form: WizardForm;
  update: (patch: Partial<WizardForm>) => void;
  error: string | null;
}) {
  const { t } = useTranslation();
  const max = OPTION_LIMITS[form.responseStyle];
  const setOption = (index: number, value: string) =>
    update({ responseOptions: form.responseOptions.map((o, i) => (i === index ? value : o)) });
  const defaultQuestion = (style: CampaignResponseStyle) => t(`campaigns.responses.defaultQuestion.${style}`);

  return (
    <div className="campaigns-attach-block campaigns-response-block">
      <label className="campaigns-checkbox">
        <input
          type="checkbox"
          checked={form.askResponse}
          onChange={e =>
            update({
              askResponse: e.target.checked,
              ...(e.target.checked && !form.responseQuestion
                ? { responseQuestion: defaultQuestion(form.responseStyle) }
                : {}),
            })
          }
        />
        <strong>{t('campaigns.responses.ask')}</strong>
      </label>
      <small>{t('campaigns.responses.askHint')}</small>

      {form.askResponse && (
        <>
          <div className="campaigns-source-toggle" role="radiogroup" aria-label={t('campaigns.responses.style')}>
            {(['poll', 'reply'] as const).map(style => (
              <label key={style}>
                <input
                  type="radio"
                  checked={form.responseStyle === style}
                  onChange={() =>
                    update({
                      responseStyle: style,
                      // Swap the stock question with the style; keep one the user typed.
                      ...(form.responseQuestion === defaultQuestion(form.responseStyle)
                        ? { responseQuestion: defaultQuestion(style) }
                        : {}),
                    })
                  }
                />
                {style === 'poll' ? <BarChart3 size={14} /> : <ListOrdered size={14} />}
                {t(`campaigns.responses.styles.${style}`)}
              </label>
            ))}
          </div>
          <small>{t(`campaigns.responses.styleHint.${form.responseStyle}`)}</small>

          <label className="form-group">
            <span>{t(`campaigns.responses.question.${form.responseStyle}`)}</span>
            <input
              value={form.responseQuestion}
              maxLength={255}
              onChange={e => update({ responseQuestion: e.target.value })}
            />
          </label>

          <div className="campaigns-presets">
            <small>{t('campaigns.responses.presets')}</small>
            {PRESETS.map(preset => (
              <button
                key={preset.key}
                type="button"
                className="campaigns-chip"
                onClick={() => update({ responseOptions: [...preset.options] })}
              >
                {preset.options.join(' / ')}
              </button>
            ))}
          </div>

          <ol className="campaigns-option-list">
            {form.responseOptions.map((option, i) => (
              <li key={i}>
                <input
                  value={option}
                  maxLength={OPTION_MAX_CHARS}
                  aria-label={t('campaigns.responses.optionLabel', { n: i + 1 })}
                  onChange={e => setOption(i, e.target.value)}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('campaigns.responses.removeOption', { n: i + 1 })}
                  disabled={form.responseOptions.length <= 2}
                  onClick={() => update({ responseOptions: form.responseOptions.filter((_, j) => j !== i) })}
                >
                  <XCircle size={14} />
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="btn-secondary campaigns-pick"
            disabled={form.responseOptions.length >= max}
            onClick={() => update({ responseOptions: [...form.responseOptions, ''] })}
          >
            <Plus size={16} />
            {t('campaigns.responses.addOption', { count: form.responseOptions.length, max })}
          </button>

          <label className="campaigns-checkbox">
            <input
              type="checkbox"
              checked={form.responseMultiple}
              onChange={e => update({ responseMultiple: e.target.checked })}
            />
            {t('campaigns.responses.multiple')}
          </label>

          {error && (
            <div className="campaigns-error" role="alert">
              {t(`campaigns.responses.errors.${error}`, { max })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What a WhatsApp poll looks like to the recipient. */
function PollMock({ question, options, multiple }: { question: string; options: string[]; multiple: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="campaigns-poll" aria-label={t('campaigns.responses.pollPreview')}>
      <strong>{question}</strong>
      <small>{multiple ? t('campaigns.responses.selectSeveral') : t('campaigns.responses.selectOne')}</small>
      <ul>
        {options.map(option => (
          <li key={option}>
            <span className={multiple ? 'campaigns-poll-box' : 'campaigns-poll-dot'} />
            {option}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Answers per option, as bars; clicking one filters the rows below to it. */
function ResponsesSection({ campaign, onPick }: { campaign: CampaignDetail; onPick: (filterKey: string) => void }) {
  const { t } = useTranslation();
  const summary = campaign.responseSummary!;
  const sent = summary.responded + summary.awaiting;
  const pct = (n: number) => (sent > 0 ? Math.round((n / sent) * 100) : 0);
  return (
    <div className="campaigns-step">
      <h3>{t('campaigns.responses.title')}</h3>
      <p className="campaigns-hint">
        {t('campaigns.responses.summary', { responded: summary.responded, sent, pct: pct(summary.responded) })}
      </p>
      <ul className="campaigns-response-bars">
        {summary.options.map(({ option, count }) => (
          <li key={option}>
            <button type="button" onClick={() => onPick(`response:${option}`)}>
              <span className="campaigns-response-label">{option}</span>
              <span className="campaigns-response-track">
                <span className="campaigns-response-fill" style={{ width: `${pct(count)}%` }} />
              </span>
              <span className="campaigns-response-count">
                {count} · {pct(count)}%
              </span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => onPick('responded:no')}>
            <span className="campaigns-response-label campaigns-muted">{t('campaigns.responses.noAnswer')}</span>
            <span className="campaigns-response-track">
              <span
                className="campaigns-response-fill campaigns-response-fill--none"
                style={{ width: `${pct(summary.awaiting)}%` }}
              />
            </span>
            <span className="campaigns-response-count">
              {summary.awaiting} · {pct(summary.awaiting)}%
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}
