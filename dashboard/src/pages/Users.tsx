import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Pencil, Trash2, UserPlus } from 'lucide-react';
import type { AuthUser, CreateAuthUserInput, UpdateAuthUserInput } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import {
  useAuthUsersQuery,
  useCreateAuthUserMutation,
  useUpdateAuthUserMutation,
  useDeleteAuthUserMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Users.css';

const roleNames = ['orgmenu', 'users'] as const;

type UserRole = (typeof roleNames)[number];

const emptyCreateForm: { name: string; email: string; password: string; role: UserRole } = {
  name: '',
  email: '',
  password: '',
  role: 'users',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface EditForm {
  name: string;
  role: UserRole;
  isActive: boolean;
  password: string;
}

export function Users() {
  const { t } = useTranslation();
  const toast = useToast();
  useDocumentTitle(t('users.title'));
  const { data: users = [], isLoading, isError } = useAuthUsersQuery();
  const createMutation = useCreateAuthUserMutation();
  const updateMutation = useUpdateAuthUserMutation();
  const deleteMutation = useDeleteAuthUserMutation();

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [createValidation, setCreateValidation] = useState<string | null>(null);
  const [editing, setEditing] = useState<AuthUser | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; email: string } | null>(null);

  const closeCreate = () => {
    setShowCreate(false);
    setCreateForm(emptyCreateForm);
    setCreateValidation(null);
  };

  const openEdit = (user: AuthUser) => {
    setEditing(user);
    setEditForm({ name: user.name ?? '', role: user.role, isActive: user.isActive, password: '' });
  };

  const validateCreate = (): string | null => {
    if (!createForm.email.trim()) return t('users.validation.emailRequired');
    if (!EMAIL_RE.test(createForm.email.trim())) return t('users.validation.emailInvalid');
    if (!createForm.password) return t('users.validation.passwordRequired');
    if (createForm.password.length < 8) return t('users.validation.passwordTooShort');
    return null;
  };

  const handleCreate = async () => {
    const problem = validateCreate();
    if (problem) {
      setCreateValidation(problem);
      return;
    }
    const payload: CreateAuthUserInput = {
      email: createForm.email.trim(),
      password: createForm.password,
      role: createForm.role,
    };
    if (createForm.name.trim()) payload.name = createForm.name.trim();
    try {
      await createMutation.mutateAsync(payload);
      toast.success(t('users.created'));
      closeCreate();
    } catch (err) {
      toast.error(t('users.errors.create'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleToggleActive = async (user: AuthUser) => {
    try {
      await updateMutation.mutateAsync({ id: user.id, data: { isActive: !user.isActive } });
      toast.success(user.isActive ? t('users.disabled') : t('users.enabled'));
    } catch (err) {
      toast.error(
        user.isActive ? t('users.errors.disable') : t('users.errors.enable'),
        err instanceof Error ? err.message : t('common.unknownError'),
      );
    }
  };

  const handleSaveEdit = async () => {
    if (!editing || !editForm) return;
    const payload: UpdateAuthUserInput = {
      name: editForm.name.trim() || undefined,
      role: editForm.role,
      isActive: editForm.isActive,
    };
    if (editForm.password) {
      if (editForm.password.length < 8) return;
      payload.password = editForm.password;
    }
    try {
      await updateMutation.mutateAsync({ id: editing.id, data: payload });
      toast.success(t('users.updated'));
      setEditing(null);
    } catch (err) {
      toast.error(t('users.errors.update'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteMutation.mutateAsync(confirmDelete.id);
      toast.success(t('users.deleted'));
      setConfirmDelete(null);
    } catch (err) {
      toast.error(t('users.errors.delete'), err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const dateShown = (iso: string): string => new Date(iso).toLocaleDateString();

  return (
    <div className="users-page">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <UserPlus size={16} />
            {t('users.addButton')}
          </button>
        }
      />

      <div className="users-content">
        <div className="users-table-container">
          {isLoading ? (
            <div className="users-loading">
              <Loader2 className="animate-spin" size={24} />
            </div>
          ) : isError ? (
            <div className="empty-table-state">{t('users.loadError')}</div>
          ) : users.length === 0 ? (
            <div className="empty-table-state">
              <KeyRound size={28} />
              <h3>{t('users.empty.title')}</h3>
              <p>{t('users.empty.description')}</p>
            </div>
          ) : (
            <table className="users-table">
              <thead>
                <tr>
                  <th>{t('users.columns.email')}</th>
                  <th>{t('users.columns.name')}</th>
                  <th>{t('users.columns.role')}</th>
                  <th>{t('users.columns.status')}</th>
                  <th>{t('users.columns.created')}</th>
                  <th>{t('users.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td className="email-cell">{user.email}</td>
                    <td>{user.name ?? '—'}</td>
                    <td>
                      <span className="role-badge">{t(`apiKeys.roles.${user.role}`)}</span>
                    </td>
                    <td>{dateShown(user.createdAt)}</td>
                    <td>
                      <span className={`status-badge ${user.isActive ? 'active' : 'disabled'}`}>
                        {t(user.isActive ? 'users.statuses.active' : 'users.statuses.disabled')}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button
                        className="icon-btn-sm"
                        title={t('users.actions.edit')}
                        aria-label={t('users.actions.edit')}
                        onClick={() => openEdit(user)}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-btn-sm"
                        title={user.isActive ? t('users.actions.disable') : t('users.actions.enable')}
                        aria-label={user.isActive ? t('users.actions.disable') : t('users.actions.enable')}
                        onClick={() => handleToggleActive(user)}
                      >
                        {user.isActive ? <span className="toggle-dot on" /> : <span className="toggle-dot" />}
                      </button>
                      <button
                        className="icon-btn-sm danger"
                        title={t('users.actions.delete')}
                        aria-label={t('users.actions.delete')}
                        onClick={() => setConfirmDelete({ id: user.id, email: user.email })}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCreate && (
        <Modal
          open
          onClose={closeCreate}
          title={t('users.modalAdd')}
          footer={
            <>
              <button className="btn-secondary" onClick={closeCreate}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('users.addButton')}
              </button>
            </>
          }
        >
          {createValidation && <p className="form-error">{createValidation}</p>}
          <label htmlFor="u-name">{t('users.form.name')}</label>
          <input
            id="u-name"
            type="text"
            placeholder={t('users.form.placeholderName')}
            value={createForm.name}
            onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
          />
          <label htmlFor="u-email">{t('users.form.email')}</label>
          <input
            id="u-email"
            type="email"
            autoComplete="off"
            value={createForm.email}
            onChange={e => setCreateForm({ ...createForm, email: e.target.value })}
          />
          <label htmlFor="u-password">{t('users.form.password')}</label>
          <input
            id="u-password"
            type="password"
            autoComplete="new-password"
            placeholder={t('users.form.passwordHint')}
            value={createForm.password}
            onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
          />
          <label htmlFor="u-role">{t('users.form.role')}</label>
          <select
            id="u-role"
            value={createForm.role}
            onChange={e => setCreateForm({ ...createForm, role: e.target.value as UserRole })}
          >
            {roleNames.map(r => (
              <option key={r} value={r}>
                {t(`apiKeys.roles.${r}`)}
              </option>
            ))}
          </select>
        </Modal>
      )}

      {editing && editForm && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={t('users.modalEdit')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={handleSaveEdit} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
              </button>
            </>
          }
        >
          <p className="email-cell">{editing.email}</p>
          <label htmlFor="u-edit-name">{t('users.form.name')}</label>
          <input
            id="u-edit-name"
            type="text"
            value={editForm.name}
            onChange={e => setEditForm({ ...editForm, name: e.target.value })}
          />
          <label htmlFor="u-edit-role">{t('users.form.role')}</label>
          <select
            id="u-edit-role"
            value={editForm.role}
            onChange={e => setEditForm({ ...editForm, role: e.target.value as UserRole })}
          >
            {roleNames.map(r => (
              <option key={r} value={r}>
                {t(`apiKeys.roles.${r}`)}
              </option>
            ))}
          </select>
          <label htmlFor="u-edit-password">{t('users.form.password')}</label>
          <input
            id="u-edit-password"
            type="password"
            autoComplete="new-password"
            placeholder={t('users.form.passwordHint')}
            value={editForm.password}
            onChange={e => setEditForm({ ...editForm, password: e.target.value })}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={editForm.isActive}
              onChange={e => setEditForm({ ...editForm, isActive: e.target.checked })}
            />
            {t('users.form.active')}
          </label>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title={t('users.confirm.deleteTitle')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : t('users.confirm.delete')}
              </button>
            </>
          }
        >
          <p>{t('users.confirm.deleteMessage')}</p>
        </Modal>
      )}
    </div>
  );
}
