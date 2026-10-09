import { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { useRole, type UserRole } from './hooks/useRole';
import { RoleProvider } from './components/RoleProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { API_BASE_URL } from './services/api';
import { clearActorState, isUserRole, resolveStartupValidation } from './utils/authLifecycle';
import './App.css';

const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Signup = lazy(() => import('./pages/Signup').then(m => ({ default: m.Signup })));
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Chats = lazy(() => import('./pages/Chats').then(m => ({ default: m.Chats })));
const Webhooks = lazy(() => import('./pages/Webhooks').then(m => ({ default: m.Webhooks })));
const Templates = lazy(() => import('./pages/Templates').then(m => ({ default: m.Templates })));
const Campaigns = lazy(() => import('./pages/Campaigns').then(m => ({ default: m.Campaigns })));
const Flow = lazy(() => import('./pages/flow'));
const PlanDetail = lazy(() => import('./pages/flow/PlanDetail'));
const Logs = lazy(() => import('./pages/Logs').then(m => ({ default: m.Logs })));
const ApiKeys = lazy(() => import('./pages/ApiKeys').then(m => ({ default: m.ApiKeys })));
const MessageTester = lazy(() => import('./pages/MessageTester').then(m => ({ default: m.MessageTester })));
const Infrastructure = lazy(() => import('./pages/Infrastructure').then(m => ({ default: m.Infrastructure })));
const Compliance = lazy(() => import('./pages/Compliance').then(m => ({ default: m.Compliance })));
const Users = lazy(() => import('./pages/Users').then(m => ({ default: m.Users })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Every role's landing page. The catch-all redirect bounces a role-gated URL an account can't
// reach to the closest page it can, so each role ends up somewhere useful instead of a dead end.
const ROLE_HOME: Record<UserRole, string> = {
  orgmenu: '/',
  users: '/sessions',
};

function AppContent() {
  const { t } = useTranslation();
  // Capture the key ONCE at mount. Read live per render, the null→key transition when
  // handleLogin stores a fresh key would re-fire the startup re-validation effect below and
  // double the /auth/validate request on every sign-in — the effect is for genuine page
  // refreshes with a saved key only.
  const [savedKey] = useState(() => sessionStorage.getItem('mywhatsapp_api_key'));
  const [isAuthenticated, setIsAuthenticated] = useState(!!savedKey);
  const [, setApiKey] = useState(savedKey || '');
  const [authView, setAuthView] = useState<'login' | 'signup'>('login');
  // Email from a just-completed signup — handed to the login view so the user only types the password.
  const [signupEmail, setSignupEmail] = useState('');
  const [signupNotice, setSignupNotice] = useState('');
  const { setRole, role } = useRole();

  const handleLogin = (key: string, validatedRole?: string) => {
    setApiKey(key);
    sessionStorage.setItem('mywhatsapp_api_key', key);

    // The login page's response already carried the freshly issued key's role, so no /auth/validate
    // round-trip is needed here. An absent or unrecognized role falls back to users, the
    // least-privileged default.
    setRole(isUserRole(validatedRole) ? validatedRole : 'users');

    setIsAuthenticated(true);
  };

  const handleLogout = useCallback(() => {
    setApiKey('');
    setIsAuthenticated(false);
    setRole(null);
    sessionStorage.removeItem('mywhatsapp_api_key');
    setAuthView('login');
    setSignupNotice('');
    // Wipe the React Query cache too: it is keyed by resource, not actor, so without a full
    // clear a logout → login in the same tab with a different key/scope shows the previous
    // actor's sessions/messages/apiKeys/audit rows.
    clearActorState(queryClient);
  }, [setRole]);

  // Re-validate and refresh the role on mount if already authenticated
  useEffect(() => {
    if (!savedKey) return;

    fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      headers: { 'X-API-Key': savedKey },
    })
      .then(async res => {
        const decision = resolveStartupValidation(res.status, await res.json().catch(() => null));
        if (decision.action === 'logout') {
          handleLogout();
        } else if (decision.action === 'role') {
          setRole(decision.role);
        }
      })
      .catch(() => {
        // Network failure (API unreachable): keep the cached role so a transient outage at
        // page load doesn't eject the user — an explicit 401/403 above still logs out.
      });
  }, [savedKey, setRole, handleLogout]);

  const loadingFallback = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <Loader2 className="animate-spin" size={32} />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense fallback={loadingFallback}>
        {authView === 'signup' ? (
          <Signup
            onSwitch={() => setAuthView('login')}
            onSignup={email => {
              setSignupEmail(email);
              setSignupNotice(t('login.createdAccount'));
              setAuthView('login');
            }}
          />
        ) : (
          <Login
            onLogin={handleLogin}
            initialEmail={signupEmail}
            notice={signupNotice}
            onSwitch={() => setAuthView('signup')}
          />
        )}
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={loadingFallback}>
          <Routes>
            <Route path="/" element={<Layout onLogout={handleLogout} userRole={role} />}>
              <Route index element={<Dashboard />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="chats" element={<Chats />} />
              {/* Every authenticated role may manage automations; only orgmenu reaches admin pages. */}
              {role !== null && <Route path="webhooks" element={<Webhooks />} />}
              {role !== null && <Route path="templates" element={<Templates />} />}
              {role !== null && <Route path="campaigns" element={<Campaigns />} />}
              {role !== null && <Route path="flow" element={<Flow />} />}
              {/* The session is in the list URL too: the detail route is a sibling, so the back
                  link needs it to restore the selection instead of reopening on whichever session
                  happens to be first. */}
              {role !== null && <Route path="flow/:sessionId" element={<Flow />} />}
              {/* A sibling of `flow`, not a child: `Route path="flow"` renders no <Outlet/>, so a
                  nested route would never match. */}
              {role !== null && <Route path="flow/:sessionId/plans/:planId" element={<PlanDetail />} />}
              {role === 'orgmenu' && <Route path="api-keys" element={<ApiKeys />} />}
              {role === 'orgmenu' && <Route path="logs" element={<Logs />} />}
              {role !== null && <Route path="message-tester" element={<MessageTester />} />}
              {role === 'orgmenu' && <Route path="infrastructure" element={<Infrastructure />} />}
              {role === 'orgmenu' && <Route path="compliance" element={<Compliance />} />}
              {role === 'orgmenu' && <Route path="users" element={<Users />} />}
              {role !== null && <Route path="*" element={<Navigate to={ROLE_HOME[role]} replace />} />}
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
