import { useState, useCallback, type ReactNode } from 'react';
import type { UserRole, RoleContextType } from '../types/role';
import { RoleContext } from '../hooks/useRole';

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole | null>(() => {
    const saved = localStorage.getItem('mywhatsapp_user_role');
    return (saved as UserRole) || null;
  });

  const setRole = useCallback((newRole: UserRole | null) => {
    setRoleState(newRole);
    if (newRole) {
      localStorage.setItem('mywhatsapp_user_role', newRole);
    } else {
      localStorage.removeItem('mywhatsapp_user_role');
    }
  }, []);

  const value: RoleContextType = {
    role,
    setRole,
    isOrgMenu: role === 'orgmenu',
    isUsers: role === 'users',
    // The collapsed two-role model has no read-only tier: 'users' absorbed the former operator
    // powers, so every authenticated account may write.
    canWrite: role === 'orgmenu' || role === 'users',
  };

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
