import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Upload } from 'lucide-react';
import { addPollOption, MIN_POLL_OPTIONS, removePollOption } from '../../utils/plans';
import { BLOCK_TYPE_KEYS } from './flowBlockMeta';
import type { FlowBlock } from '../../types/plans';

/**
 * Shared block field controls, used by both the list view and the mind-map's inline editor so a
 * block looks and edits the same wherever it appears.
 */

/**
 * A labelled control. Owning the `useId` here means every field gets a unique id without the
 * caller threading one through, and the hint is wired into `aria-describedby` for free.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flow-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy: hint ? hintId : undefined })}
      {hint && (
        <p className="input-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Uploads a file and returns the fields a block needs to point at it. */
export type MediaUploader = (file: File) => Promise<{ url: string; filename: string }>;

/** The blocks that carry a media URL: images, videos and documents. */
type MediaBlock = Extract<FlowBlock, { type: 'image' | 'video' | 'file' }>;

function PollOptionsField({
  block,
  onChange,
}: {
  block: Extract<FlowBlock, { type: 'poll' }>;
  onChange: (next: FlowBlock) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flow-poll-options">
      <legend>{t('flow.blocks.field.options')}</legend>
      {block.options.map((option, index) => {
        // Derived from the block id rather than useId(): a hook inside .map() would run a varying
        // number of times as options are added, breaking the rules of hooks.
        const optionId = `${block.id}-opt-${index}`;
        return (
          <div className="flow-poll-option" key={optionId}>
            <label className="sr-only" htmlFor={optionId}>
              {t('flow.blocks.field.optionLabelFor', { index: index + 1 })}
            </label>
            <input
              id={optionId}
              type="text"
              value={option}
              onChange={event => {
                const options = [...block.options];
                options[index] = event.target.value;
                onChange({ ...block, options });
              }}
              placeholder={t('flow.blocks.field.optionPlaceholder', { index: index + 1 })}
            />
            <button
              type="button"
              className="icon-btn danger"
              onClick={() => onChange({ ...block, options: removePollOption(block.options, index) })}
              disabled={block.options.length <= MIN_POLL_OPTIONS}
              aria-label={t('flow.blocks.field.removeOptionFor', { index: index + 1 })}
            >
              <Trash2 size={16} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="btn-secondary flow-poll-add"
        onClick={() => onChange({ ...block, options: addPollOption(block.options) })}
      >
        <Plus size={16} />
        {t('flow.blocks.field.addOption')}
      </button>
    </fieldset>
  );
}

/**
 * Upload, replace or clear the media on a block. The URL field below still works, so a pasted link
 * and an uploaded file are interchangeable; the button simply fills the same field.
 */
function MediaUploadControl({
  block,
  onChange,
  onUploadMedia,
}: {
  block: MediaBlock;
  onChange: (next: FlowBlock) => void;
  onUploadMedia: MediaUploader;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const hasMedia = block.mediaUrl.trim() !== '';
  const accept = block.type === 'image' ? 'image/*' : block.type === 'video' ? 'video/*' : undefined;

  const clear = () => {
    onChange(block.type === 'file' ? { ...block, mediaUrl: '', filename: '' } : { ...block, mediaUrl: '' });
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again after an error still fires a change.
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(false);
    void onUploadMedia(file)
      .then(uploaded => {
        onChange(
          block.type === 'file'
            ? {
                ...block,
                mediaUrl: uploaded.url,
                filename: block.filename.trim() !== '' ? block.filename : uploaded.filename,
              }
            : { ...block, mediaUrl: uploaded.url },
        );
      })
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flow-upload">
      <input
        id={inputId}
        className="sr-only flow-upload-input"
        type="file"
        accept={accept}
        disabled={busy}
        onChange={onFile}
      />
      <div className="flow-upload-actions">
        <label htmlFor={inputId} className="btn-secondary flow-upload-btn">
          <Upload size={16} aria-hidden="true" />
          {t(hasMedia ? 'flow.blocks.field.replaceMedia' : 'flow.blocks.field.uploadMedia')}
        </label>
        {hasMedia && (
          <button
            type="button"
            className="icon-btn danger"
            onClick={clear}
            aria-label={t('flow.blocks.field.removeMedia')}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
        {busy && <span className="flow-upload-busy">{t('flow.blocks.field.uploading')}</span>}
      </div>
      {error && (
        <p className="flow-upload-error" role="alert">
          {t('flow.blocks.field.uploadError')}
        </p>
      )}
    </div>
  );
}

/**
 * The per-type fields. A `switch` narrows the discriminated union per branch; the shared
 * image/video fields are grouped under stacked `case` labels.
 */
export function BlockFields({
  block,
  onChange,
  onUploadMedia,
}: {
  block: FlowBlock;
  onChange: (next: FlowBlock) => void;
  onUploadMedia?: MediaUploader;
}) {
  const { t } = useTranslation();

  switch (block.type) {
    case 'text':
      return (
        <Field label={t('flow.blocks.field.text')}>
          {({ id }) => (
            <textarea
              id={id}
              rows={3}
              value={block.text}
              onChange={event => onChange({ ...block, text: event.target.value })}
              placeholder={t('flow.blocks.field.textPlaceholder')}
            />
          )}
        </Field>
      );

    case 'image':
    case 'video': {
      const kind = t(BLOCK_TYPE_KEYS[block.type]);
      return (
        <>
          {onUploadMedia && <MediaUploadControl block={block} onChange={onChange} onUploadMedia={onUploadMedia} />}
          <Field label={t('flow.blocks.field.mediaUrl')} hint={t('flow.blocks.field.mediaHint', { kind })}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="url"
                inputMode="url"
                value={block.mediaUrl}
                onChange={event => onChange({ ...block, mediaUrl: event.target.value })}
                placeholder="https://"
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label={t('flow.blocks.field.caption')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={block.caption}
                onChange={event => onChange({ ...block, caption: event.target.value })}
                placeholder={t('flow.blocks.field.captionPlaceholder')}
              />
            )}
          </Field>
        </>
      );
    }

    case 'file': {
      const kind = t(BLOCK_TYPE_KEYS.file);
      return (
        <>
          <Field label={t('flow.blocks.field.filename')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={block.filename}
                onChange={event => onChange({ ...block, filename: event.target.value })}
                placeholder={t('flow.blocks.field.filenamePlaceholder')}
              />
            )}
          </Field>
          {onUploadMedia && <MediaUploadControl block={block} onChange={onChange} onUploadMedia={onUploadMedia} />}
          <Field label={t('flow.blocks.field.mediaUrl')} hint={t('flow.blocks.field.mediaHint', { kind })}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="url"
                inputMode="url"
                value={block.mediaUrl}
                onChange={event => onChange({ ...block, mediaUrl: event.target.value })}
                placeholder="https://"
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label={t('flow.blocks.field.caption')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={block.caption}
                onChange={event => onChange({ ...block, caption: event.target.value })}
                placeholder={t('flow.blocks.field.captionPlaceholder')}
              />
            )}
          </Field>
        </>
      );
    }

    case 'poll':
      return (
        <>
          <Field label={t('flow.blocks.field.question')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={block.question}
                onChange={event => onChange({ ...block, question: event.target.value })}
                placeholder={t('flow.blocks.field.questionPlaceholder')}
              />
            )}
          </Field>
          <PollOptionsField block={block} onChange={onChange} />
        </>
      );

    case 'yesno':
      return (
        <>
          <Field label={t('flow.blocks.field.question')}>
            {({ id }) => (
              <input
                id={id}
                type="text"
                value={block.question}
                onChange={event => onChange({ ...block, question: event.target.value })}
                placeholder={t('flow.blocks.field.questionPlaceholder')}
              />
            )}
          </Field>
          <div className="flow-field-pair">
            <Field label={t('flow.blocks.field.yesLabel')}>
              {({ id }) => (
                <input
                  id={id}
                  type="text"
                  value={block.yesLabel}
                  onChange={event => onChange({ ...block, yesLabel: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('flow.blocks.field.noLabel')}>
              {({ id }) => (
                <input
                  id={id}
                  type="text"
                  value={block.noLabel}
                  onChange={event => onChange({ ...block, noLabel: event.target.value })}
                />
              )}
            </Field>
          </div>
        </>
      );
  }
}
