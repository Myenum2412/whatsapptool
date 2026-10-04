import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Plus, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Modal } from '../../components/Modal';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useToast } from '../../hooks/useToast';
import {
  useCreatePlanMutation,
  useDeletePlanMutation,
  usePlansQuery,
  useSessionsQuery,
  useUpdatePlanMutation,
} from '../../hooks/queries';
import { PlanFormModal } from './PlanFormModal';
import { PlansList } from './PlansList';
import { selectAllPlanIds, togglePlanId } from '../../utils/plans';
import type { Plan, PlanDraft } from '../../types/plans';
import './flow.css';

/**
 * The /flow plans page, at /flow and /flow/:sessionId.
 *
 * Plans are session-scoped and persisted, so this page owns three things the old in-memory version
 * did not: a session picker (the API cannot answer "all plans" without one), the loading and error
 * states that any remote list needs, and mutations that report the server's answer rather than
 * assuming success.
 *
 * The session lives in the URL as well as in a `<select>`. It is not cosmetic: the detail route is a
 * sibling, so without it in the path the back link would have to reconstruct the selection, and a
 * shared link would land on whichever session happened to be first.
 */
export function Flow() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  useDocumentTitle(t('flow.plans.title'));
  const toast = useToast();

  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [selectedSessionId, setSelectedSessionId] = useState('');

  // Default to the first session so the page is useful on arrival, and adopt one from the URL when the
  // page is re-entered from the detail route's back link or a shared link.
  useEffect(() => {
    if (routeSessionId) {
      setSelectedSessionId(routeSessionId);
    } else if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [routeSessionId, selectedSessionId, sessions]);

  const {
    data: plans = [],
    isLoading: loadingPlans,
    error: plansError,
  } = usePlansQuery(selectedSessionId, !!selectedSessionId);

  const createMutation = useCreatePlanMutation();
  const updateMutation = useUpdatePlanMutation();
  const deleteMutation = useDeletePlanMutation();

  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  // The form is mounted only while open, so its draft is seeded fresh on every launch. `editingPlan`
  // alone does not track visibility: a non-null value with no dialog is how a half-typed plan would
  // silently persist to the next open.
  const [formOpen, setFormOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<Plan[] | null>(null);

  const openCreate = () => {
    setEditingPlan(null);
    setFormOpen(true);
  };

  const openEdit = (plan: Plan) => {
    setEditingPlan(plan);
    setFormOpen(true);
  };

  /** Surface the server's own message; a bare "failed" hides a duplicate-title 409. */
  const reportFailure = (err: unknown) => {
    toast.error(t('flow.plans.toasts.failed'), err instanceof Error ? err.message : t('common.unknownError'));
  };

  const handleSubmit = async (draft: PlanDraft) => {
    const payload = { title: draft.title.trim(), description: draft.description.trim() };
    try {
      if (editingPlan) {
        await updateMutation.mutateAsync({ sessionId: selectedSessionId, id: editingPlan.id, data: payload });
        toast.success(t('flow.plans.toasts.updated'));
      } else {
        await createMutation.mutateAsync({ sessionId: selectedSessionId, data: payload });
        toast.success(t('flow.plans.toasts.created'));
      }
      setFormOpen(false);
      setEditingPlan(null);
    } catch (err) {
      // The dialog stays open on failure: closing it would discard what was typed.
      reportFailure(err);
    }
  };

  const runDelete = async (targets: Plan[]) => {
    try {
      // Sequential rather than Promise.all: the bulk bar reports one count, and a partial failure
      // then leaves an accurate remainder instead of an unhandled rejection.
      let removed = 0;
      for (const plan of targets) {
        await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: plan.id });
        removed += 1;
      }
      toast.success(
        targets.length === 1
          ? t('flow.plans.toasts.deleted')
          : t('flow.plans.toasts.deletedSelected', { count: removed }),
      );
    } catch (err) {
      reportFailure(err);
    } finally {
      setSelectedIds([]);
      setDeleteTarget(null);
      setBulkDeleteTargets(null);
    }
  };

  const handleToggleSelectAll = () => {
    setSelectedIds(prev => selectAllPlanIds(plans, prev));
  };

  const hasSelection = selectedIds.length > 0;

  if (loadingSessions) {
    return (
      <div className="flow-page flow-page-centered">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="flow-page">
      <PageHeader
        title={t('flow.plans.title')}
        subtitle={t('flow.plans.subtitle')}
        actions={
          <>
            {sessions.length > 0 && (
              <select
                className="flow-session-select"
                aria-label={t('flow.plans.sessionSelect')}
                value={selectedSessionId}
                onChange={event => {
                  // Selection is scoped to the rows it was made against.
                  setSelectedIds([]);
                  setDeleteTarget(null);
                  setBulkDeleteTargets(null);
                  // The URL is the source of truth on re-entry, so switching has to move it too.
                  setSelectedSessionId(event.target.value);
                  navigate(`/flow/${event.target.value}`);
                }}
              >
                {sessions.map(session => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn-primary" onClick={openCreate} disabled={!selectedSessionId}>
              <Plus size={16} />
              {t('flow.plans.newPlan')}
            </button>
          </>
        }
      />

      {sessions.length === 0 ? (
        <div className="plans-empty">
          <AlertCircle size={48} strokeWidth={1} />
          <h3>{t('flow.plans.noSessionsTitle')}</h3>
          <p>{t('flow.plans.noSessionsDescription')}</p>
        </div>
      ) : (
        <>
          {hasSelection && (
            <div className="plans-bulk-bar" role="region" aria-label={t('flow.plans.select.bulkRegion')}>
              <span className="plans-bulk-count">
                {t('flow.plans.select.selectedCount', { count: selectedIds.length })}
              </span>
              <div className="plans-bulk-actions">
                <button type="button" className="btn-secondary" onClick={() => setSelectedIds([])}>
                  {t('flow.plans.select.clear')}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => setBulkDeleteTargets(plans.filter(plan => selectedIds.includes(plan.id)))}
                >
                  <Trash2 size={16} />
                  {t('flow.plans.select.deleteSelected')}
                </button>
              </div>
            </div>
          )}

          {loadingPlans ? (
            <div className="flow-page-centered">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : plansError && plans.length === 0 ? (
            <div className="plans-empty">
              <AlertCircle size={48} strokeWidth={1} />
              <h3>{t('flow.plans.loadErrorTitle')}</h3>
              <p>{plansError instanceof Error ? plansError.message : t('common.unknownError')}</p>
            </div>
          ) : (
            <PlansList
              plans={plans}
              selectedIds={selectedIds}
              onToggleSelect={id => setSelectedIds(prev => togglePlanId(prev, id))}
              onToggleSelectAll={handleToggleSelectAll}
              onView={plan => navigate(`/flow/${selectedSessionId}/plans/${plan.id}`)}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          )}
        </>
      )}

      {formOpen && <PlanFormModal plan={editingPlan} onClose={() => setFormOpen(false)} onSubmit={handleSubmit} />}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('flow.plans.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => runDelete([deleteTarget])}
                disabled={deleteMutation.isPending}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('flow.plans.deleteConfirm')}</p>
          <code>{deleteTarget.title}</code>
        </Modal>
      )}

      {bulkDeleteTargets && (
        <Modal
          open
          onClose={() => setBulkDeleteTargets(null)}
          title={t('flow.plans.bulkDeleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setBulkDeleteTargets(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => runDelete(bulkDeleteTargets)}
                disabled={deleteMutation.isPending}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('flow.plans.bulkDeleteConfirm', { count: bulkDeleteTargets.length })}</p>
        </Modal>
      )}
    </div>
  );
}

export default Flow;
