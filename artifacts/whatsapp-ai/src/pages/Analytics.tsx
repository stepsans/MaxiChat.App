import {
  useGetAnalyticsSummary,
  useGetCommonQuestions,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from "recharts";
import { TrendingUp, Bot, UserCheck, MessageSquare, Users, Flame } from "lucide-react";

const COLORS = ["hsl(142,71%,40%)", "hsl(35,90%,60%)", "hsl(0,84%,60%)", "hsl(210,90%,60%)", "hsl(280,80%,60%)"];

export default function Analytics() {
  const { data: summary, isLoading: summaryLoading } = useGetAnalyticsSummary();
  const { data: commonQs, isLoading: qsLoading } = useGetCommonQuestions();

  const pieData = summary
    ? [
        { name: "AI Handled", value: summary.aiHandled },
        { name: "Needs Human", value: summary.needsHuman },
        { name: "Closed", value: summary.closed },
      ].filter((d) => d.value > 0)
    : [];

  const tagData = summary
    ? [
        { name: "Hot Lead", value: summary.hotLeads },
        { name: "Closing", value: summary.closingLeads },
        { name: "Cold", value: summary.coldLeads },
      ]
    : [];

  const labelData = summary?.chatsByLabel ?? [];

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Analytics</h1>
          <p className="text-xs text-muted-foreground">Performance overview and insights</p>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {summaryLoading ? (
            Array(4)
              .fill(0)
              .map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)
          ) : (
            <>
              <Card data-testid="stat-total-chats">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Chats</p>
                  <p className="text-2xl font-bold mt-1">{summary?.totalChats ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{summary?.todayChats ?? 0} today</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-closing-rate">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Closing Rate</p>
                  <p className="text-2xl font-bold mt-1 text-primary">{summary?.closingRate ?? 0}%</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{summary?.closingLeads ?? 0} closing</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-ai-handled">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">AI Handled</p>
                  <p className="text-2xl font-bold mt-1">{summary?.aiHandled ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">auto-replied</p>
                </CardContent>
              </Card>
              <Card data-testid="stat-total-messages">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Messages</p>
                  <p className="text-2xl font-bold mt-1">{summary?.totalMessages ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">all time</p>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Chat Status Distribution */}
          <Card data-testid="chart-status-distribution">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Chat Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-48" />
              ) : pieData.length === 0 ? (
                <div className="h-48 flex items-center justify-center text-muted-foreground">
                  <p className="text-sm">No data yet</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {pieData.map((_, index) => (
                        <Cell key={index} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(215,15%,12%)",
                        border: "1px solid hsl(215,15%,18%)",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: "11px" }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Lead Tags */}
          <Card data-testid="chart-lead-tags">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Lead Tags</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-48" />
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={tagData} barSize={28}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(215,15%,18%)" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(215,15%,12%)",
                        border: "1px solid hsl(215,15%,18%)",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {tagData.map((_, index) => (
                        <Cell key={index} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Chats by Label */}
        {labelData.length > 0 && (
          <Card data-testid="chart-chats-by-label">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Chat per Label</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading ? (
                <Skeleton className="h-48" />
              ) : (
                <ResponsiveContainer
                  width="100%"
                  height={Math.max(120, labelData.length * 44)}
                >
                  <BarChart data={labelData} layout="vertical" barSize={20}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(215,15%,18%)"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={140}
                      tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(215,15%,12%)",
                        border: "1px solid hsl(215,15%,18%)",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {labelData.map((label) => (
                        <Cell key={label.id} fill={label.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        )}

        {/* Common Questions */}
        <Card data-testid="chart-common-questions">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Most Common Customer Questions</CardTitle>
          </CardHeader>
          <CardContent>
            {qsLoading ? (
              <div className="space-y-2">
                {Array(5).fill(0).map((_, i) => <Skeleton key={i} className="h-8" />)}
              </div>
            ) : !commonQs || commonQs.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-muted-foreground">
                <p className="text-sm">No data yet — questions will appear as chats come in</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={commonQs} layout="vertical" barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(215,15%,18%)" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="question"
                    width={160}
                    tick={{ fontSize: 11, fill: "hsl(215,10%,65%)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(215,15%,12%)",
                      border: "1px solid hsl(215,15%,18%)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(142,71%,40%)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
