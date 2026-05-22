import { useLogout } from "@workspace/api-client-react";

// Thin wrapper that lets us pass an onSuccess from the caller without
// having to thread the orval `mutation:` options shape everywhere.
export function useLogoutMutation(opts: {
  onSuccess?: () => void;
}) {
  return useLogout({
    mutation: {
      onSuccess: () => {
        opts.onSuccess?.();
      },
    },
  });
}
