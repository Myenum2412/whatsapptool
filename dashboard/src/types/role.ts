// Role types for RBAC
export type UserRole = 'orgmenu' | 'users';

export interface RoleContextType {
  role: UserRole | null;
  setRole: (role: UserRole | null) => void;
  isOrgMenu: boolean;
  isUsers: boolean;
  canWrite: boolean;
}
