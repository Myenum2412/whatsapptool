import type { ChangeEvent } from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import type { MediaUploader } from './FlowBlockFields';
import type { FlowBlock } from '../../types/plans';

type MediaBlock = Extract<FlowBlock, { type: 'image' | 'video' | 'file' }>;

/**
 * The hero of a media card that has nothing to show yet: a dashed plate that opens the file picker.
 *
 * Without this the only way to put a picture or a document on a plan is to select the block and use
 * the side panel, which makes the chart read-only for the one thing media blocks are *for*. Once the
 * block has media the hero shows it instead, and replacing stays in the panel where the URL field
 * sits — so this is the empty state, not a second way to do everything.
 *
 * Uploading is deliberately not a drag target: the node itself is the drag surface for moving the
 * card, and one pointer gesture cannot mean both.
 */
export function FlowCardMediaUpload({
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
  const [failed, setFailed] = useState(false);
  const accept = block.type === 'image' ? 'image/*' : block.type === 'video' ? 'video/*' : undefined;

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again after a failure still fires a change.
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setFailed(false);
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
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flow-map-node-upload" data-node-control>
      <input
        id={inputId}
        className="sr-only"
        type="file"
        accept={accept}
        disabled={busy}
        onChange={onFile}
        aria-label={t('flow.blocks.field.uploadMedia')}
      />
      <label htmlFor={inputId} className="flow-map-node-upload-btn">
        <Upload size={16} aria-hidden="true" />
        <span>{busy ? t('flow.blocks.field.uploading') : t('flow.blocks.field.uploadMedia')}</span>
      </label>
      {failed && (
        <span className="flow-map-node-upload-error" role="alert">
          {t('flow.blocks.field.uploadError')}
        </span>
      )}
    </div>
  );
}
