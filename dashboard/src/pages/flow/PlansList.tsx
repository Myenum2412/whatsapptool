import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ClipboardList, Eye, Pencil, Trash2 } from 'lucide-react';
import { allPlanIdsSelected, somePlanIdsSelected } from '../../utils/plans';
import type { Plan } from '../../types/plans';

interface PlansListProps {
  plans: Plan[];
  selectedIds: readonly string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onView: (plan: Plan) => void;
  onEdit: (plan: Plan) => void;
  onDelete: (plan: Plan) => void;
}

/**
 * The saved plans as a card list: selection, title, description, last update, and the per-card
 * view/edit/delete actions. The card layout is the redesign of the old dense table — the same
 * selection model (a header select-all and a per-row checkbox) is kept so the bulk bar behaves
 * identically. Renders an empty state instead of a header with no cards beneath it.
 */
export function PlansList({
  plans,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onView,
  onEdit,
  onDelete,
}: PlansListProps) {
  const { t } = useTranslation();

  // `indeterminate` is a DOM-only property with no HTML attribute, so it has to be assigned
  // imperatively — `checked` alone would leave a half-selected list reading as "nothing selected".
  const selectAllRef = useRef<HTMLInputElement>(null);
  const allSelected = allPlanIdsSelected(plans, selectedIds);
  const someSelected = somePlanIdsSelected(plans, selectedIds);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  if (plans.length === 0) {
    return (
      <div className="plans-empty">
        <ClipboardList size={48} strokeWidth={1} />
        <h3>{t('flow.plans.empty.title')}</h3>
        <p>{t('flow.plans.empty.description')}</p>
      </div>
    );
  }

  return (
    <div className="plans-list">
      <label className="plans-select-all">
        <input
          ref={selectAllRef}
          type="checkbox"
          checked={allSelected}
          onChange={onToggleSelectAll}
          aria-label={t('flow.plans.select.all')}
        />
        <span>{t('flow.plans.select.all')}</span>
      </label>

      <ul className="plans-cards">
        {plans.map(plan => (
          <li key={plan.id} className={`plan-card${selectedIds.includes(plan.id) ? ' plan-card-selected' : ''}`}>
            <label className="plan-card-check">
              <input
                type="checkbox"
                checked={selectedIds.includes(plan.id)}
                onChange={() => onToggleSelect(plan.id)}
                aria-label={t('flow.plans.select.planFor', { title: plan.title })}
              />
            </label>

            <button type="button" className="plan-card-main" onClick={() => onView(plan)}>
              <span className="plan-card-title">{plan.title}</span>
              <span className="plans-description-cell">
                {plan.description || <span className="plans-muted">—</span>}
              </span>
              <span className="plan-card-updated">
                <CalendarClock size={13} aria-hidden="true" />
                {new Date(plan.updatedAt).toLocaleDateString()}
              </span>
            </button>

            <div className="plans-actions">
              <button
                type="button"
                className="icon-btn"
                onClick={() => onView(plan)}
                aria-label={t('flow.plans.table.viewFor', { title: plan.title })}
              >
                <Eye size={16} />
                <span className="sr-only">{t('flow.plans.table.view')}</span>
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => onEdit(plan)}
                aria-label={t('flow.plans.table.editFor', { title: plan.title })}
              >
                <Pencil size={16} />
                <span className="sr-only">{t('common.edit')}</span>
              </button>
              <button
                type="button"
                className="icon-btn danger"
                onClick={() => onDelete(plan)}
                aria-label={t('flow.plans.table.deleteFor', { title: plan.title })}
              >
                <Trash2 size={16} />
                <span className="sr-only">{t('common.delete')}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
