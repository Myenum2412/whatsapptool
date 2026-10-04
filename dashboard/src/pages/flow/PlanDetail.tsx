import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  FileQuestion,
  Loader2,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { PageHeader } from '../../components/PageHeader';
import { Modal } from '../../components/Modal';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useToast } from '../../hooks/useToast';
import { useDeletePlanMutation, usePlanQuery, useUpdatePlanMutation } from '../../hooks/queries';
import { PlanFlowEditor } from './PlanFlowEditor';
import { PlanFormModal } from './PlanFormModal';
import type { PlanDraft } from '../../types/plans';

/**
 * View of a single plan, at /flow/:sessionId/plans/:planId.
 *
 * The plan is fetched by its session-scoped key rather than looked up in a list, so a hard refresh
 * (or a plan deleted in another tab) resolves instead of rendering a blank page. A `404` means the
 * record is gone and is reported as not-found; any other failure is a read that never landed and
 * gets the server's own message, because "deleted" would be a guess.
 *
 * The plan's own name and existence are edited from here rather than only from the list, because the
 * chart is where the work happens: renaming or discarding the plan you are looking at should not
 * require walking back out to the table first. The rename reuses the same dialog the list uses, so
 * title and description are validated identically in both places.
 */
export function PlanDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId, planId } = useParams<{ sessionId: string; planId: string }>();
  const { data: plan, isLoading, error } = usePlanQuery(sessionId ?? '', planId ?? '', !!sessionId && !!planId);
  const updatePlan = useUpdatePlanMutation();
  const deletePlan = useDeletePlanMutation();
  const toast = useToast();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Unconditional so the hook order survives the not-found branch below.
  useDocumentTitle(plan ? plan.title : t('flow.plans.detail.notFoundTitle'));

  const backTo = sessionId ? `/flow/${sessionId}` : '/flow';
  const missing = (error as { status?: number } | null)?.status === 404;

  if (isLoading) {
    return (
      <div className="flow-page flow-page-centered">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="flow-page">
        <PageHeader title={t('flow.plans.title')} subtitle={t('flow.plans.subtitle')} />
        <div className="plans-empty">
          {error && !missing ? <AlertCircle size={48} strokeWidth={1} /> : <FileQuestion size={48} strokeWidth={1} />}
          <h3>{error && !missing ? t('flow.plans.loadErrorTitle') : t('flow.plans.detail.notFoundTitle')}</h3>
          <p>{error && !missing ? error.message : t('flow.plans.detail.notFoundDescription')}</p>
          <Link className="btn-secondary plans-back-link" to={backTo}>
            <ArrowLeft size={16} />
            {t('flow.plans.detail.back')}
          </Link>
        </div>
      </div>
    );
  }

  const saveRename = async (draft: PlanDraft) => {
    try {
      await updatePlan.mutateAsync({
        sessionId: plan.sessionId,
        id: plan.id,
        data: { title: draft.title.trim(), description: draft.description.trim() },
      });
      toast.success(t('flow.plans.toasts.updated'));
      setRenameOpen(false);
    } catch (err) {
      // The dialog stays open on failure, or a duplicate title 409 would throw the edit away.
      toast.error(t('flow.plans.toasts.failed'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const confirmDelete = async () => {
    try {
      await deletePlan.mutateAsync({ sessionId: plan.sessionId, id: plan.id });
      toast.success(t('flow.plans.toasts.deleted'));
      navigate(backTo);
    } catch (err) {
      toast.error(t('flow.plans.toasts.failed'), err instanceof Error ? err.message : t('common.unknownError'));
      setDeleteOpen(false);
    }
  };

  const created = new Date(plan.createdAt).toLocaleString();
  const updated = new Date(plan.updatedAt).toLocaleString();

  return (
    <div className="flow-page">
      <PageHeader
        title={plan.title}
        subtitle={t('flow.plans.detail.subtitle')}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRenameOpen(true)}
              aria-label={t('flow.plans.table.editFor', { title: plan.title })}
            >
              <Pencil size={16} />
              {t('common.edit')}
            </button>
            <button
              type="button"
              className="btn-secondary plan-detail-delete"
              onClick={() => setDeleteOpen(true)}
              aria-label={t('flow.plans.table.deleteFor', { title: plan.title })}
            >
              <Trash2 size={16} />
              {t('common.delete')}
            </button>
            <Link className="btn-secondary" to={backTo}>
              <ArrowLeft size={16} />
              {t('flow.plans.detail.back')}
            </Link>
          </>
        }
      />

      <div className="plan-detail">
        <p className="plan-detail-description">
          {plan.description || <span className="plans-muted">{t('flow.plans.detail.noDescription')}</span>}
        </p>
        <div className="plan-detail-chips">
          <span className="plan-chip">
            <CalendarClock size={15} aria-hidden="true" />
            <span className="plan-chip-label">{t('flow.plans.detail.createdLabel')}</span>
            <span className="plan-chip-value">{created}</span>
          </span>
          <span className="plan-chip">
            <RefreshCw size={15} aria-hidden="true" />
            <span className="plan-chip-label">{t('flow.plans.detail.updatedLabel')}</span>
            <span className="plan-chip-value">{updated}</span>
          </span>
          <span className="plan-chip">
            <MessagesSquare size={15} aria-hidden="true" />
            <span className="plan-chip-label">{t('flow.blocks.heading')}</span>
            <span className="plan-chip-value">{plan.flow.length}</span>
          </span>
        </div>
      </div>

      <PlanFlowEditor sessionId={plan.sessionId} plan={plan} />

      {renameOpen && <PlanFormModal plan={plan} onClose={() => setRenameOpen(false)} onSubmit={saveRename} />}

      {deleteOpen && (
        <Modal
          open
          onClose={() => setDeleteOpen(false)}
          title={t('flow.plans.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setDeleteOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn-danger" onClick={confirmDelete} disabled={deletePlan.isPending}>
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('flow.plans.deleteConfirm')}</p>
          <code>{plan.title}</code>
        </Modal>
      )}
    </div>
  );
}

export default PlanDetail;
