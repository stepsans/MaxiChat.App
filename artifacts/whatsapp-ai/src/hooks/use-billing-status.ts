import {
  useGetMyBilling,
  getGetMyBillingQueryKey,
} from "@workspace/api-client-react";

// Resolves the caller tenant's read-only state from /billing/me. Works for
// every team role (the endpoint resolves to the owner), so the read-only
// banner and disabled controls behave the same for super_admin and members.
// Polls so an admin "mark paid" unblocks the tenant within a minute without
// a manual refresh.
export function useBillingStatus() {
  const { data, isLoading } = useGetMyBilling({
    query: {
      queryKey: getGetMyBillingQueryKey(),
      refetchInterval: 60_000,
      retry: false,
    },
  });
  return {
    readOnly: data?.subscription.readOnly ?? false,
    effectiveStatus: data?.subscription.effectiveStatus ?? null,
    status: data?.subscription.status ?? null,
    currentPeriodEnd: data?.subscription.currentPeriodEnd ?? null,
    isLoading,
  };
}
