import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Chats from "@/pages/Chats";
import Status from "@/pages/Status";
import Knowledge from "@/pages/Knowledge";
import Settings from "@/pages/Settings";
import Analytics from "@/pages/Analytics";
import Products from "@/pages/Products";
import Flows from "@/pages/Flows";
import FlowEditor from "@/pages/FlowEditor";
import Credentials from "@/pages/Credentials";
import Login from "@/pages/Login";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // 401 from /auth/me is the "logged out" signal — don't retry, just
      // redirect. Other failures still get one retry.
      retry: (failureCount, error: any) => {
        if (error?.status === 401) return false;
        return failureCount < 1;
      },
    },
  },
});

// Single source of truth for "am I signed in?". When /auth/me returns 401 we
// render the login page; on success the rest of the app mounts. Any API call
// that 401s elsewhere will surface as a normal error — the next refetch of
// /auth/me will then bounce the user back to login.
function AuthGate() {
  const [location, navigate] = useLocation();
  const { data, isLoading, error } = useGetMe({
    query: {
      queryKey: ["/api/auth/me"],
      // Re-check periodically so a server-side session expiry kicks the user
      // back to /login without requiring a manual refresh.
      refetchInterval: 60_000,
    },
  });

  const isAuthed = !!data?.user;
  const status = (error as any)?.status;
  const isUnauthed = status === 401 || (!isLoading && !isAuthed);
  const onLogin = location === "/login";

  useEffect(() => {
    if (isUnauthed && !onLogin) navigate("/login");
    if (isAuthed && onLogin) navigate("/");
  }, [isUnauthed, isAuthed, onLogin, navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthed || onLogin) {
    return (
      <Switch>
        <Route path="/login" component={Login} />
        <Route component={Login} />
      </Switch>
    );
  }

  return (
    <Layout user={data!.user ?? undefined}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/chats" component={Chats} />
        <Route path="/chats/:id" component={Chats} />
        <Route path="/status" component={Status} />
        <Route path="/knowledge" component={Knowledge} />
        <Route path="/products" component={Products} />
        <Route path="/flows" component={Flows} />
        <Route path="/flows/:id" component={FlowEditor} />
        <Route path="/credentials" component={Credentials} />
        <Route path="/settings" component={Settings} />
        <Route path="/analytics" component={Analytics} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
