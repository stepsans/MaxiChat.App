import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useGetAnalyticsSummary,
  useGetCommonQuestions,
  getGetAnalyticsSummaryQueryKey,
  getGetCommonQuestionsQueryKey,
} from "@workspace/api-client-react";

import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";

type Tone = "primary" | "danger" | "success" | "info";

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: keyof typeof Feather.glyphMap;
  tone: Tone;
}) {
  const colors = useColors();
  const toneColor =
    tone === "danger"
      ? colors.danger
      : tone === "success"
        ? colors.success
        : tone === "info"
          ? colors.info
          : colors.primary;
  return (
    <View
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={[styles.cardIcon, { backgroundColor: toneColor + "1f" }]}>
        <Feather name={icon} size={18} color={toneColor} />
      </View>
      <Text style={[styles.cardValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.cardLabel, { color: colors.mutedForeground }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activeChannelId } = useChannel();

  const enabled = activeChannelId != null;

  const {
    data: summary,
    isLoading,
    isRefetching,
    refetch,
  } = useGetAnalyticsSummary({
    query: {
      queryKey: getGetAnalyticsSummaryQueryKey(),
      enabled,
      refetchInterval: 30000,
    },
  });

  const { data: questions, refetch: refetchQ } = useGetCommonQuestions({
    query: {
      queryKey: getGetCommonQuestionsQueryKey(),
      enabled,
    },
  });

  const closingRate =
    summary && summary.totalChats > 0
      ? Math.round((summary.closed / summary.totalChats) * 100)
      : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Dashboard" right={<ChannelSwitcher />} />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => {
                refetch();
                refetchQ();
              }}
              tintColor={colors.primary}
            />
          }
        >
          <View style={styles.grid}>
            <StatCard
              label="Total Chat"
              value={String(summary?.totalChats ?? 0)}
              icon="message-square"
              tone="primary"
            />
            <StatCard
              label="Perlu Dibalas"
              value={String(summary?.needsHuman ?? 0)}
              icon="alert-circle"
              tone="danger"
            />
            <StatCard
              label="Leads"
              value={String(summary?.leads ?? 0)}
              icon="user-check"
              tone="success"
            />
            <StatCard
              label="Closing Rate"
              value={`${closingRate}%`}
              icon="trending-up"
              tone="info"
            />
          </View>

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Pertanyaan Teratas
          </Text>
          <View
            style={[
              styles.questionCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {questions && questions.length > 0 ? (
              questions.slice(0, 8).map((q, i) => (
                <View
                  key={`${q.question}-${i}`}
                  style={[
                    styles.qRow,
                    i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
                  ]}
                >
                  <View style={[styles.qRank, { backgroundColor: colors.primarySoft }]}>
                    <Text style={[styles.qRankText, { color: colors.primaryDark }]}>
                      {i + 1}
                    </Text>
                  </View>
                  <Text
                    style={[styles.qText, { color: colors.foreground }]}
                    numberOfLines={2}
                  >
                    {q.question}
                  </Text>
                  <Text style={[styles.qCount, { color: colors.mutedForeground }]}>
                    {q.count}×
                  </Text>
                </View>
              ))
            ) : (
              <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                Belum ada data pertanyaan.
              </Text>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  card: {
    width: "47%",
    flexGrow: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 6,
  },
  cardIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardValue: { fontFamily: "Inter_700Bold", fontSize: 26 },
  cardLabel: { fontFamily: "Inter_500Medium", fontSize: 13 },
  sectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    marginTop: 24,
    marginBottom: 10,
  },
  questionCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  qRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  qRank: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  qRankText: { fontFamily: "Inter_700Bold", fontSize: 12 },
  qText: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 14 },
  qCount: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 28,
  },
});
