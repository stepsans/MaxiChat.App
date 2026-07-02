import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/hooks/use-theme";
import { NotificationSoundProvider } from "@/hooks/use-notification-sound";
import { useGetMe, useHeartbeat } from "@workspace/api-client-react";
import NotFound from "@/pages/not-found";
import Layout from "@/components/Layout";
import { ChannelProvider } from "@/contexts/ChannelContext";
import Channels from "@/pages/Channels";
import Dashboard from "@/pages/Dashboard";
import Chats from "@/pages/Chats";
import ChatInsights from "@/pages/ChatInsights";
import WorkboardInsights from "@/pages/WorkboardInsights";
import AgentKpiInsights from "@/pages/AgentKpiInsights";
import Status from "@/pages/Status";
import Knowledge from "@/pages/Knowledge";
import Settings from "@/pages/Settings";
import AIStudio from "@/pages/AIStudio";
import Usage from "@/pages/Usage";
import LearningInbox from "@/pages/LearningInbox";
import Billing from "@/pages/Billing";
import ReportsAndSchedules from "@/pages/ReportsAndSchedules";
import AIPipeline from "@/pages/AIPipeline";
import AIPipelineNew from "@/pages/AIPipelineNew";
import AIPipelineDetail from "@/pages/AIPipelineDetail";
import Products from "@/pages/Products";
import Flows from "@/pages/Flows";
import FlowEditor from "@/pages/FlowEditor";
import Credentials from "@/pages/Credentials";
import AIReview from "@/pages/AIReview";
import WorkBoard from "@/pages/WorkBoard";
import BoardDetail from "@/pages/WorkBoard/BoardDetail";
import Agents from "@/pages/Agents";
import Profile from "@/pages/Profile";
import Login from "@/pages/Login";
import SignUp from "@/pages/SignUp";
import VerifyEmail from "@/pages/VerifyEmail";
import InviteVerify from "@/pages/InviteVerify";
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
  // Routes that should always be reachable without a session — sign-up,
  // email verification, login, and agent invitation verify.
  const path = location.split("?")[0];
  const isPublicRoute =
    path === "/login" ||
    path === "/signup" ||
    path === "/verify-email" ||
    path === "/invite/verify";

  useEffect(() => {
    if (isUnauthed && !isPublicRoute) navigate("/login");
    // Don't kick authed users off /verify-email — they may have followed
    // a link in their inbox after already signing in elsewhere.
    if (isAuthed && (path === "/login" || path === "/signup")) navigate("/");
  }, [isUnauthed, isAuthed, isPublicRoute, path, navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthed || isPublicRoute) {
    return (
      <Switch>
        <Route path="/login" component={Login} />
        <Route path="/signup" component={SignUp} />
        <Route path="/verify-email" component={VerifyEmail} />
        <Route path="/invite/verify" component={InviteVerify} />
        <Route component={Login} />
      </Switch>
    );
  }

  return (
    <ChannelProvider>
      <PresenceHeartbeat />
      <Layout user={data!.user ?? undefined}>
        <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/chat-insights" component={ChatInsights} />
        <Route path="/workboard-insights" component={WorkboardInsights} />
        <Route path="/agent-kpi" component={AgentKpiInsights} />
        <Route path="/chats" component={Chats} />
        <Route path="/chats/:id" component={Chats} />
        <Route path="/status" component={Status} />
        <Route path="/knowledge" component={Knowledge} />
        <Route path="/products" component={Products} />
        <Route path="/flows" component={Flows} />
        <Route path="/flows/:id" component={FlowEditor} />
        <Route path="/credentials" component={Credentials} />
        <Route path="/ai-review" component={AIReview} />
        <Route path="/agents" component={Agents} />
        <Route path="/channels" component={Channels} />
        <Route path="/settings" component={Settings} />
        <Route path="/ai-studio" component={AIStudio} />
        <Route path="/usage" component={Usage} />
        <Route path="/learning-inbox" component={LearningInbox} />
        <Route path="/lead-reviews">{() => <Redirect to="/learning-inbox" />}</Route>
        <Route path="/billing" component={Billing} />
        <Route path="/profile" component={Profile} />
        <Route path="/analytics" component={ReportsAndSchedules} />
        <Route path="/workboard" component={WorkBoard} />
        <Route path="/workboard/:boardId" component={BoardDetail} />
        {/* ACR pages folded into Laporan & Jadwal — keep old links working. */}
        {/* AI Chat Report (ACR) retired into Laporan & Jadwal — keep old links working. */}
        <Route path="/ai-chat-report/settings">{() => <Redirect to="/analytics?tab=summary" />}</Route>
        <Route path="/ai-chat-report/:jobId">{() => <Redirect to="/analytics?tab=ai" />}</Route>
        <Route path="/ai-chat-report">{() => <Redirect to="/analytics?tab=ai" />}</Route>
        <Route path="/ai-pipeline" component={AIPipeline} />
        <Route path="/ai-pipeline/new" component={AIPipelineNew} />
        <Route path="/ai-pipeline/:id/edit" component={AIPipelineDetail} />
        <Route path="/ai-pipeline/:id" component={AIPipelineDetail} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </ChannelProvider>
  );
}

// Ping the server every 30s while the tab is alive so round-robin can tell
// who's online. Pauses while the tab is hidden — an agent on a backgrounded
// tab shouldn't catch new chats they won't see for a while.
function PresenceHeartbeat() {
  const mut = useHeartbeat();
  useEffect(() => {
    const ping = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      mut.mutate();
    };
    ping();
    const id = window.setInterval(ping, 30_000);
    const onVis = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <NotificationSoundProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AuthGate />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </NotificationSoundProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
