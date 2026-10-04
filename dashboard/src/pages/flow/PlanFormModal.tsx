import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../components/Modal';
import { planToDraft } from '../../utils/plans';
import type { Plan, PlanDraft } from '../../types/plans';

interface PlanFormModalProps {
  /** The plan being edited, or null when creating a new one. */
  plan: Plan | null;
  onClose: () => void;
  onSubmit: (draft: PlanDraft) => void;
}

const blankDraft: PlanDraft = { title: '', description: '' };

/**
 * Create/edit dialog for a plan: a title and a description.
 *
 * The parent mounts this only while the dialog should be open, so the draft is seeded once from
 * `plan` on mount. That is what keeps a half-typed plan from leaking into the next open — an effect
 * re-seeding on `plan` would race the first keystroke.
 */
export function PlanFormModal({ plan, onClose, onSubmit }: PlanFormModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const titleErrorId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();

  const [draft, setDraft] = useState<PlanDraft>(() => (plan ? planToDraft(plan) : { ...blankDraft }));
  // Validation only surfaces once a submit has been attempted, so opening the dialog on a blank
  // form does not greet the user with a red "required" before they have typed anything.
  const [submitted, setSubmitted] = useState(false);

  const titleMissing = draft.title.trim() === '';

  const submit = () => {
    setSubmitted(true);
    if (titleMissing) return;
    onSubmit(draft);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={plan ? t('flow.plans.form.editTitle') : t('flow.plans.form.createTitle')}
      closeLabel={t('common.close')}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={submit}>
            {plan ? t('common.save') : t('common.create')}
          </button>
        </>
      }
    >
      <label htmlFor={titleId}>{t('flow.plans.form.title')}</label>
      <input
        id={titleId}
        type="text"
        value={draft.title}
        onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
        placeholder={t('flow.plans.form.titlePlaceholder')}
        aria-invalid={submitted && titleMissing}
        aria-describedby={submitted && titleMissing ? titleErrorId : undefined}
      />
      {submitted && titleMissing && (
        <p className="input-error" id={titleErrorId}>
          {t('flow.plans.form.titleRequired')}
        </p>
      )}

      <label htmlFor={descriptionId}>{t('flow.plans.form.description')}</label>
      <textarea
        id={descriptionId}
        rows={4}
        value={draft.description}
        onChange={event => setDraft(prev => ({ ...prev, description: event.target.value }))}
        placeholder={t('flow.plans.form.descriptionPlaceholder')}
        aria-describedby={descriptionHintId}
      />
      <p className="input-hint" id={descriptionHintId}>
        {t('flow.plans.form.descriptionHint')}
      </p>
    </Modal>
  );
}
