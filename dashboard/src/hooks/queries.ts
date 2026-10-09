import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionApi,
  webhookApi,
  templateApi,
  planApi,
  campaignApi,
  apiKeyApi,
  authUsersApi,
  auditApi,
  infraApi,
  statsApi,
  type Webhook,
  type WebhookFilters,
  type TemplatePayload,
  type PlanPayload,
  type CampaignRecipientFilter,
  type CreateCampaignPayload,
  type StatsPeriod,
  type CreateAuthUserInput,
  type UpdateAuthUserInput,
} from '../services/api';

// ── Query Keys ────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  sessionStats: ['sessions', 'stats'] as const,
  sessionGroups: (sessionId: string) => ['sessions', sessionId, 'groups'] as const,
  sessionChats: (sessionId: string) => ['sessions', sessionId, 'chats'] as const,
  webhooks: ['webhooks'] as const,
  templates: (sessionId: string) => ['sessions', sessionId, 'templates'] as const,
  plans: (sessionId: string) => ['sessions', sessionId, 'plans'] as const,
  plan: (sessionId: string, planId: string) => ['sessions', sessionId, 'plans', planId] as const,
  campaigns: (sessionId: string) => ['sessions', sessionId, 'campaigns'] as const,
  campaign: (sessionId: string, id: string) => ['sessions', sessionId, 'campaigns', id] as const,
  campaignRecipients: (sessionId: string, id: string, filter: string, page: number) =>
    ['sessions', sessionId, 'campaigns', id, 'recipients', filter, page] as const,
  apiKeys: ['apiKeys'] as const,
  authUsers: ['authUsers'] as const,
  logs: (params: { severity?: string; page: number; limit: number }) => ['logs', params] as const,
  infraStatus: ['infra', 'status'] as const,
  engines: ['engines'] as const,
  currentEngine: ['engines', 'current'] as const,
  statsOverview: ['stats', 'overview'] as const,
  statsMessages: (period: string) => ['stats', 'messages', period] as const,
};

// ── Session Queries ───────────────────────────────────────────────────

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: sessionApi.list,
    staleTime: 30_000,
  });
}

export function useSessionStatsQuery() {
  return useQuery({
    queryKey: queryKeys.sessionStats,
    queryFn: sessionApi.getStats,
    staleTime: 30_000,
  });
}

export function useSessionGroupsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionGroups(sessionId),
    queryFn: () => sessionApi.getGroups(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useSessionChatsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId),
    queryFn: () => sessionApi.getChats(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.stop(id),
    // A failed stop can still have changed the session, so the list is re-read either way.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ── Webhook Queries ───────────────────────────────────────────────────

export function useWebhooksQuery() {
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: webhookApi.listAll,
    staleTime: 30_000,
    // Normalize `events` to an array at the data boundary so every consumer (list render + edit
    // modal) can trust the declared string[] shape. A malformed payload then renders as no tags
    // instead of taking down the whole SPA via events.map() in the ErrorBoundary.
    select: webhooks => webhooks.map(w => ({ ...w, events: Array.isArray(w.events) ? w.events : [] })),
  });
}

export function useCreateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; url: string; events: string[]; filters?: WebhookFilters | null }) =>
      webhookApi.create(params.sessionId, { url: params.url, events: params.events, filters: params.filters }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useUpdateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<Webhook> }) =>
      webhookApi.update(params.sessionId, params.id, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useDeleteWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => webhookApi.delete(params.sessionId, params.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

// ── Template Queries ─────────────────────────────────────────────────────────

export function useTemplatesQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(sessionId),
    queryFn: () => templateApi.list(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 30_000,
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; data: TemplatePayload }) =>
      templateApi.create(params.sessionId, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<TemplatePayload> }) =>
      templateApi.update(params.sessionId, params.id, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => templateApi.delete(params.sessionId, params.id),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

// ── Flow Plan Queries ─────────────────────────────────────────────────────────

export function usePlansQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.plans(sessionId),
    queryFn: () => planApi.list(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 30_000,
  });
}

export function usePlanQuery(sessionId: string, planId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.plan(sessionId, planId),
    queryFn: () => planApi.get(sessionId, planId),
    enabled: enabled && !!sessionId && !!planId,
  });
}

export function useCreatePlanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; data: PlanPayload }) => planApi.create(params.sessionId, params.data),
    onSuccess: (_plan, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans(params.sessionId) });
    },
  });
}

export function useUpdatePlanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<PlanPayload> }) =>
      planApi.update(params.sessionId, params.id, params.data),
    // Writes the one plan it touched into the cache instead of refetching the list, so the flow
    // editor's autosave does not refetch the whole table underneath the table page.
    onSuccess: (plan, params) => {
      queryClient.setQueryData(queryKeys.plan(params.sessionId, params.id), plan);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans(params.sessionId) });
    },
  });
}

export function useDeletePlanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => planApi.delete(params.sessionId, params.id),
    onSuccess: (_plan, params) => {
      queryClient.removeQueries({ queryKey: queryKeys.plan(params.sessionId, params.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans(params.sessionId) });
    },
  });
}

// ── API Key Queries ───────────────────────────────────────────────────

export function useApiKeysQuery() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: apiKeyApi.list,
    staleTime: 30_000,
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      role: string;
      allowedIps?: string[];
      allowedSessions?: string[];
      expiresAt?: string;
    }) => apiKeyApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useUpdateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        name?: string;
        role?: string;
        allowedIps?: string[];
        allowedSessions?: string[];
        expiresAt?: string;
      };
    }) => apiKeyApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useDeleteApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ── Login-account (user) queries ──────────────────────────────────────

export function useAuthUsersQuery() {
  return useQuery({
    queryKey: queryKeys.authUsers,
    queryFn: authUsersApi.list,
    staleTime: 30_000,
  });
}

export function useCreateAuthUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAuthUserInput) => authUsersApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authUsers });
    },
  });
}

export function useUpdateAuthUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAuthUserInput }) => authUsersApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authUsers });
    },
  });
}

export function useDeleteAuthUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authUsersApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authUsers });
    },
  });
}

// ── Logs Queries ──────────────────────────────────────────────────────

export function useLogsQuery(params: { severity?: string; page: number; limit: number }) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: () =>
      auditApi.list({
        severity: params.severity,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
      }),
    staleTime: 15_000,
  });
}

// ── Infrastructure Queries ────────────────────────────────────────────

export function useInfraStatusQuery() {
  return useQuery({
    queryKey: queryKeys.infraStatus,
    queryFn: infraApi.getStatus,
    staleTime: 30_000,
  });
}

export function useInfraConfigQuery() {
  return useQuery({
    queryKey: ['infra', 'config'],
    queryFn: infraApi.getConfig,
    staleTime: 30_000,
  });
}

export function useEnginesQuery() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: infraApi.getEngines,
    staleTime: 60_000,
  });
}

export function useCurrentEngineQuery() {
  return useQuery({
    queryKey: queryKeys.currentEngine,
    queryFn: infraApi.getCurrentEngine,
    staleTime: 60_000,
  });
}

// ── Stats Queries ─────────────────────────────────────────────────────
// /stats/* is ADMIN-only; a non-admin key gets 403 → don't retry, let the UI fall back gracefully.

export function useStatsOverviewQuery() {
  return useQuery({
    queryKey: queryKeys.statsOverview,
    queryFn: statsApi.getOverview,
    staleTime: 30_000,
    retry: false,
  });
}

export function useStatsMessagesQuery(period: StatsPeriod) {
  return useQuery({
    queryKey: queryKeys.statsMessages(period),
    queryFn: () => statsApi.getMessages(period),
    staleTime: 30_000,
    retry: false,
  });
}

// ── Campaigns (mail merge) ────────────────────────────────────────────

/** Polls every 3s while any campaign in the list is running, so progress moves without a reload. */
export function useCampaignsQuery(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.campaigns(sessionId),
    queryFn: () => campaignApi.list(sessionId),
    enabled: !!sessionId,
    refetchInterval: query => (query.state.data?.some(c => c.status === 'running') ? 3000 : false),
  });
}

export function useCampaignQuery(sessionId: string, id: string | null) {
  return useQuery({
    queryKey: queryKeys.campaign(sessionId, id ?? ''),
    queryFn: () => campaignApi.get(sessionId, id!),
    enabled: !!sessionId && !!id,
    // Sending moves fast; answers keep arriving for days after the last send, so a campaign that asks
    // for responses keeps refreshing (slower) once it has gone out.
    refetchInterval: query => {
      const data = query.state.data;
      if (data?.status === 'running') return 3000;
      return data?.responseOptions && data.status !== 'draft' ? 10_000 : false;
    },
  });
}

export function useCampaignRecipientsQuery(
  sessionId: string,
  id: string | null,
  filter: CampaignRecipientFilter,
  page: number,
  live: boolean,
) {
  return useQuery({
    queryKey: queryKeys.campaignRecipients(sessionId, id ?? '', JSON.stringify(filter), page),
    queryFn: () => campaignApi.recipients(sessionId, id!, { ...filter, page, limit: 50 }),
    enabled: !!sessionId && !!id,
    refetchInterval: live ? 5000 : false,
  });
}

export function useCreateCampaignMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; file: File; data: CreateCampaignPayload }) =>
      campaignApi.create(params.sessionId, params.file, params.data),
    onSuccess: (_campaign, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaigns(params.sessionId) });
    },
  });
}

/** Refresh everything cached under a session's campaigns (list, detail, recipient pages). */
export function useInvalidateCampaigns() {
  const queryClient = useQueryClient();
  return (sessionId: string) => queryClient.invalidateQueries({ queryKey: queryKeys.campaigns(sessionId) });
}

/** Start/resume, pause, cancel and delete share one shape: act, then refresh everything under the campaign. */
export function useCampaignActionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      sessionId: string;
      id: string;
      action: 'start' | 'pause' | 'cancel' | 'delete';
    }): Promise<void> => {
      await campaignApi[params.action](params.sessionId, params.id);
    },
    onSuccess: (_result, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.campaigns(params.sessionId) });
    },
  });
}
