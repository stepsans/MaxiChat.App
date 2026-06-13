import {
  pgTable,
  uuid,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";
import { channelsTable } from "./channels";

// ===========================================================================
// AI Chat Report (ACR) — AI-driven CS team performance evaluation.
// Reads chat transcripts per agent, scores 5 KPI dimensions, detects red
// flags, and converts the total score to a grade + allowance (whole Rupiah).
//
// Spec adaptations to this codebase: users/channels/chats are integer ids
// (the spec's generic SQL used UUIDs); "contact" maps to a chats row
// (phone_number-keyed), so conversation/red-flag rows carry chat_id +
// contact name/phone snapshots instead of a contact_id UUID.
// ===========================================================================

// Per-tenant KPI weight configuration (editable by super_admin only).
// SUM of the five weight_* columns must equal 100 — enforced at the route.
export const acrConfigsTable = pgTable(
  "acr_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    weightResponseTime: integer("weight_response_time").notNull().default(25),
    weightLanguageQuality: integer("weight_language_quality").notNull().default(25),
    weightAnswerQuality: integer("weight_answer_quality").notNull().default(25),
    weightComplaintHandling: integer("weight_complaint_handling").notNull().default(15),
    weightMissedChat: integer("weight_missed_chat").notNull().default(10),

    // Response-time SLA thresholds in minutes; must be strictly ascending.
    slaExcellentMinutes: integer("sla_excellent_minutes").notNull().default(3),
    slaGoodMinutes: integer("sla_good_minutes").notNull().default(5),
    slaAcceptableMinutes: integer("sla_acceptable_minutes").notNull().default(15),
    slaPoorMinutes: integer("sla_poor_minutes").notNull().default(30),
    slaCriticalMinutes: integer("sla_critical_minutes").notNull().default(60),

    // Minimum total score per grade; must be strictly descending. Below D = E.
    gradeAThreshold: integer("grade_a_threshold").notNull().default(90),
    gradeBThreshold: integer("grade_b_threshold").notNull().default(75),
    gradeCThreshold: integer("grade_c_threshold").notNull().default(60),
    gradeDThreshold: integer("grade_d_threshold").notNull().default(45),

    // Allowance per grade — whole-integer Rupiah.
    allowanceGradeA: bigint("allowance_grade_a", { mode: "number" }).notNull().default(0),
    allowanceGradeB: bigint("allowance_grade_b", { mode: "number" }).notNull().default(0),
    allowanceGradeC: bigint("allowance_grade_c", { mode: "number" }).notNull().default(0),
    allowanceGradeD: bigint("allowance_grade_d", { mode: "number" }).notNull().default(0),
    allowanceGradeE: bigint("allowance_grade_e", { mode: "number" }).notNull().default(0),

    complaintHandlingEnabled: boolean("complaint_handling_enabled").notNull().default(true),

    // Opt-in: evaluate the tenant owner (super_admin) as an agent too.
    // Useful for single-operator tenants and testing; off by default.
    includeOwnerInEvaluation: boolean("include_owner_in_evaluation")
      .notNull()
      .default(false),

    autoScheduleEnabled: boolean("auto_schedule_enabled").notNull().default(false),
    // 'weekly' | 'monthly' | 'custom'
    autoScheduleFrequency: text("auto_schedule_frequency").notNull().default("monthly"),
    autoScheduleDayOfMonth: integer("auto_schedule_day_of_month").default(1),
    // 1=Senin … 7=Minggu
    autoScheduleDayOfWeek: integer("auto_schedule_day_of_week").default(1),
    // For 'custom': every N days.
    autoScheduleEveryDays: integer("auto_schedule_every_days").default(30),
    autoScheduleNotifyUserIds: integer("auto_schedule_notify_user_ids")
      .array()
      .notNull()
      .default([]),
    autoScheduleNextRunAt: timestamp("auto_schedule_next_run_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("acr_configs_owner_unique").on(t.ownerUserId)]
);

// One evaluation run. config_snapshot is immutable after creation — all
// calculations use the snapshot, never the live config.
export const acrJobsTable = pgTable(
  "acr_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    // Evaluated period — DATE in the tenant's timezone (Asia/Jakarta).
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    requestedByUserId: integer("requested_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    isAutoScheduled: boolean("is_auto_scheduled").notNull().default(false),

    // Only the agents explicitly requested (empty/null = all agents).
    agentUserIds: integer("agent_user_ids").array(),

    // Manual lead classifications ('lead' | 'not_lead' | 'unknown') whose
    // chats are analyzed. Null/empty (pre-feature rows) = all chats; new jobs
    // default to ['lead'].
    leadStatuses: text("lead_statuses").array(),

    // Optional analysis filters. Null/empty = no restriction (all). All
    // filters AND together with leadStatuses + agentUserIds.
    // Restrict to specific channels (chats.channel_id).
    channelIds: integer("channel_ids").array(),
    // Restrict to chats whose contact carries one of these customer labels
    // (contact_labels.label_id).
    customerLabelIds: integer("customer_label_ids").array(),
    // Restrict to chats with one of these handling statuses
    // ('ai_handled' | 'needs_human' | 'closed').
    chatStatuses: text("chat_statuses").array(),

    // Per-job override of the config's includeOwnerInEvaluation. Null = inherit
    // the config snapshot; set at creation so re-runs stay consistent.
    includeOwner: boolean("include_owner"),

    // Source of the job. 'manual' (user-triggered) | 'scheduled' (acr_schedules).
    jobType: text("job_type").notNull().default("manual"),
    // The schedule that spawned this job (null for manual). FK set null on
    // schedule delete so the report survives.
    scheduleId: uuid("schedule_id"),
    // Persisted PDF (Bagian II "full" — reserved; populated once PDF auto-gen ships).
    pdfPath: text("pdf_path"),
    pdfGeneratedAt: timestamp("pdf_generated_at", { withTimezone: true }),

    // 'pending' | 'running' | 'completed' | 'failed'
    status: text("status").notNull().default("pending"),

    progressTotal: integer("progress_total").notNull().default(0),
    progressCompleted: integer("progress_completed").notNull().default(0),

    totalAgentsEvaluated: integer("total_agents_evaluated").notNull().default(0),
    totalConversationsAnalyzed: integer("total_conversations_analyzed").notNull().default(0),
    totalMessagesAnalyzed: integer("total_messages_analyzed").notNull().default(0),

    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>().notNull(),

    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("acr_jobs_owner_idx").on(t.ownerUserId, t.createdAt),
    index("acr_jobs_status_idx").on(t.status),
  ]
);

export type AcrCoachingInsights = {
  top_improvements: string[];
  best_conversation_id: string | null;
  worst_conversation_id: string | null;
  best_conversation_excerpt: string;
  worst_conversation_excerpt: string;
  worst_conversation_annotation: string;
  team_comparison: {
    avg_response_time_team: number;
    avg_score_team: number;
    agent_rank: number;
    total_agents: number;
  };
};

// Aggregated result per agent per job.
export const acrAgentScoresTable = pgTable(
  "acr_agent_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => acrJobsTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull(),

    agentUserId: integer("agent_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    agentName: text("agent_name"),
    agentEmail: text("agent_email"),
    // 'supervisor' | 'agent' (super_admin replies count as supervisor scope)
    agentRole: text("agent_role").notNull(),

    totalScore: numeric("total_score", { precision: 5, scale: 2 }).notNull().default("0"),

    // Weighted dimension scores (already multiplied by their weight).
    scoreResponseTime: numeric("score_response_time", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreLanguageQuality: numeric("score_language_quality", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreAnswerQuality: numeric("score_answer_quality", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreComplaintHandling: numeric("score_complaint_handling", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    scoreMissedChat: numeric("score_missed_chat", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),

    avgResponseTimeMinutes: numeric("avg_response_time_minutes", { precision: 8, scale: 2 }),
    totalConversations: integer("total_conversations").notNull().default(0),
    totalMessagesSent: integer("total_messages_sent").notNull().default(0),
    totalMissedChats: integer("total_missed_chats").notNull().default(0),
    totalComplaints: integer("total_complaints").notNull().default(0),
    complaintsResolved: integer("complaints_resolved").notNull().default(0),
    // true when the agent had < 5 conversations in the period.
    insufficientData: boolean("insufficient_data").notNull().default(false),

    grade: text("grade").notNull().default("E"),
    allowanceAmount: bigint("allowance_amount", { mode: "number" }).notNull().default(0),

    aiSummary: text("ai_summary"),
    aiStrengths: text("ai_strengths"),
    aiImprovements: text("ai_improvements"),

    coachingInsights: jsonb("coaching_insights").$type<AcrCoachingInsights>(),

    redFlagCount: integer("red_flag_count").notNull().default(0),
    hasCriticalViolation: boolean("has_critical_violation").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("acr_agent_scores_job_idx").on(t.jobId),
    index("acr_agent_scores_agent_idx").on(t.agentUserId),
    uniqueIndex("acr_agent_scores_job_agent_unique").on(t.jobId, t.agentUserId),
  ]
);

// Severe violations detected by AI or by deterministic rules.
export const acrRedFlagsTable = pgTable(
  "acr_red_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => acrJobsTable.id, { onDelete: "cascade" }),
    agentScoreId: uuid("agent_score_id")
      .notNull()
      .references(() => acrAgentScoresTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull(),

    agentUserId: integer("agent_user_id").notNull(),
    agentName: text("agent_name"),

    chatId: integer("chat_id"),
    contactName: text("contact_name"),
    channelId: integer("channel_id").references(() => channelsTable.id, {
      onDelete: "set null",
    }),
    channelType: text("channel_type"),

    // Relevant conversation excerpt, max 500 chars.
    conversationExcerpt: text("conversation_excerpt"),

    // 'customer_angry' | 'rude_language' | 'no_reply_critical'
    // | 'customer_ignored' | 'answer_caused_dropout'
    violationType: text("violation_type").notNull(),
    // 'critical' | 'high' | 'medium'
    violationSeverity: text("violation_severity").notNull().default("high"),

    aiExplanation: text("ai_explanation").notNull(),
    aiRecommendation: text("ai_recommendation"),

    scoreImpactDimension: text("score_impact_dimension"),
    scoreImpactPoints: numeric("score_impact_points", { precision: 5, scale: 2 }),

    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    messageTimestamp: timestamp("message_timestamp", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("acr_red_flags_job_idx").on(t.jobId),
    index("acr_red_flags_agent_score_idx").on(t.agentScoreId),
  ]
);

// Per-conversation detail under one agent score.
export const acrConversationScoresTable = pgTable(
  "acr_conversation_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => acrJobsTable.id, { onDelete: "cascade" }),
    agentScoreId: uuid("agent_score_id")
      .notNull()
      .references(() => acrAgentScoresTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull(),

    agentUserId: integer("agent_user_id").notNull(),
    chatId: integer("chat_id"),
    contactName: text("contact_name"),
    channelId: integer("channel_id").references(() => channelsTable.id, {
      onDelete: "set null",
    }),
    channelType: text("channel_type"),

    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    totalMessages: integer("total_messages").notNull().default(0),
    agentMessages: integer("agent_messages").notNull().default(0),
    customerMessages: integer("customer_messages").notNull().default(0),

    avgResponseTimeMinutes: numeric("avg_response_time_minutes", { precision: 8, scale: 2 }),
    firstResponseTimeMinutes: numeric("first_response_time_minutes", {
      precision: 8,
      scale: 2,
    }),
    maxResponseTimeMinutes: numeric("max_response_time_minutes", { precision: 8, scale: 2 }),
    hasMissedMessage: boolean("has_missed_message").notNull().default(false),
    hasComplaint: boolean("has_complaint").notNull().default(false),
    complaintResolved: boolean("complaint_resolved").notNull().default(false),

    // Per-conversation raw scores (0–100, pre-weighting).
    convScoreResponseTime: numeric("conv_score_response_time", { precision: 5, scale: 2 }),
    convScoreLanguageQuality: numeric("conv_score_language_quality", {
      precision: 5,
      scale: 2,
    }),
    convScoreAnswerQuality: numeric("conv_score_answer_quality", { precision: 5, scale: 2 }),
    convScoreComplaintHandling: numeric("conv_score_complaint_handling", {
      precision: 5,
      scale: 2,
    }),
    convScoreMissedChat: numeric("conv_score_missed_chat", { precision: 5, scale: 2 }),
    convTotalScore: numeric("conv_total_score", { precision: 5, scale: 2 }),

    hasRedFlag: boolean("has_red_flag").notNull().default(false),
    redFlagTypes: text("red_flag_types").array(),

    aiNotes: text("ai_notes"),
    answerCausedCustomerSilent: boolean("answer_caused_customer_silent")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("acr_conversation_scores_job_idx").on(t.jobId),
    index("acr_conversation_scores_agent_score_idx").on(t.agentScoreId),
    index("acr_conversation_scores_agent_idx").on(t.jobId, t.agentUserId),
  ]
);

// In-app red-flag notifications (bell badge).
export const acrNotificationsTable = pgTable(
  "acr_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id").notNull(),
    recipientUserId: integer("recipient_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    redFlagId: uuid("red_flag_id").references(() => acrRedFlagsTable.id, {
      onDelete: "cascade",
    }),
    jobId: uuid("job_id").references(() => acrJobsTable.id, { onDelete: "cascade" }),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("acr_notifications_recipient_idx").on(t.recipientUserId, t.isRead)]
);

// ---------------------------------------------------------------------------
// Recurring report schedules (Bagian II). Multiple named schedules per tenant;
// supersedes the single per-tenant acr_configs.auto_schedule_* mechanism.
// ---------------------------------------------------------------------------
export const acrSchedulesTable = pgTable(
  "acr_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),

    // 'daily' | 'weekly' | 'monthly'
    frequency: text("frequency").notNull(),
    // weekly only: 0=Sunday … 6=Saturday (JS getDay convention). Null otherwise.
    dayOfWeek: integer("day_of_week"),
    // monthly only: 1–28. Null otherwise.
    dayOfMonth: integer("day_of_month"),
    // Execution time in `timezone` (default WIB).
    cutoffHour: integer("cutoff_hour").notNull().default(9),
    cutoffMinute: integer("cutoff_minute").notNull().default(0),
    timezone: text("timezone").notNull().default("Asia/Jakarta"),

    // null/empty = all agents.
    agentUserIds: integer("agent_user_ids").array(),
    notifyUserIds: integer("notify_user_ids").array().notNull().default([]),

    // Reserved for the "full" phase (PDF auto-gen + WhatsApp); stored now.
    generatePdf: boolean("generate_pdf").notNull().default(true),
    sendWhatsappPdf: boolean("send_whatsapp_pdf").notNull().default(false),

    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunJobId: uuid("last_run_job_id"),
    totalRuns: integer("total_runs").notNull().default(0),

    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("acr_schedules_owner_idx").on(t.ownerUserId),
    index("acr_schedules_due_idx").on(t.nextRunAt).where(sql`${t.isActive}`),
  ]
);

// ---------------------------------------------------------------------------
// Per-job KPI snapshot (Bagian II). Pre-aggregated team metrics, filled when a
// job (manual or scheduled) completes. Powers the Dashboard KPI (Bagian III).
// Idempotent: unique per job_id (upsert on re-run).
// ---------------------------------------------------------------------------
export const acrKpiSnapshotsTable = pgTable(
  "acr_kpi_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => acrJobsTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").notNull(),
    scheduleId: uuid("schedule_id"),

    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    periodLabel: text("period_label").notNull(),
    jobType: text("job_type").notNull().default("manual"),
    frequency: text("frequency"),

    teamAvgScore: numeric("team_avg_score", { precision: 5, scale: 2 }),
    teamAvgResponseTime: numeric("team_avg_response_time", { precision: 8, scale: 2 }),
    teamAvgLanguage: numeric("team_avg_language", { precision: 5, scale: 2 }),
    teamAvgAnswer: numeric("team_avg_answer", { precision: 5, scale: 2 }),
    teamAvgComplaint: numeric("team_avg_complaint", { precision: 5, scale: 2 }),
    teamAvgMissed: numeric("team_avg_missed", { precision: 5, scale: 2 }),

    countGradeA: integer("count_grade_a").notNull().default(0),
    countGradeB: integer("count_grade_b").notNull().default(0),
    countGradeC: integer("count_grade_c").notNull().default(0),
    countGradeD: integer("count_grade_d").notNull().default(0),
    countGradeE: integer("count_grade_e").notNull().default(0),
    totalAgents: integer("total_agents").notNull().default(0),

    totalRedFlags: integer("total_red_flags").notNull().default(0),
    totalCustomerAngry: integer("total_customer_angry").notNull().default(0),
    totalRudeLanguage: integer("total_rude_language").notNull().default(0),
    totalNoReplyCritical: integer("total_no_reply_critical").notNull().default(0),
    totalCustomerIgnored: integer("total_customer_ignored").notNull().default(0),
    totalAnswerDropout: integer("total_answer_dropout").notNull().default(0),

    totalConversations: integer("total_conversations").notNull().default(0),
    totalMessages: integer("total_messages").notNull().default(0),
    totalMissedChats: integer("total_missed_chats").notNull().default(0),
    totalComplaints: integer("total_complaints").notNull().default(0),
    complaintsResolved: integer("complaints_resolved").notNull().default(0),

    topPerformerName: text("top_performer_name"),
    topPerformerScore: numeric("top_performer_score", { precision: 5, scale: 2 }),
    topPerformerGrade: text("top_performer_grade"),
    botPerformerName: text("bot_performer_name"),
    botPerformerScore: numeric("bot_performer_score", { precision: 5, scale: 2 }),
    botPerformerGrade: text("bot_performer_grade"),

    totalAllowanceAmount: bigint("total_allowance_amount", { mode: "number" })
      .notNull()
      .default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("acr_kpi_snapshots_job_unique").on(t.jobId),
    index("acr_kpi_snapshots_owner_period_idx").on(t.ownerUserId, t.periodStart),
  ]
);

// ---------------------------------------------------------------------------
// Bagian IV — advanced features: per-agent targets (9.1), performance alerts
// (9.2), team groups/benchmark (9.3), achievements (9.6). All additive and
// independent of the core scoring pipeline.
// ---------------------------------------------------------------------------

// 9.1 Per-agent KPI score target set by the super admin.
export const acrAgentTargetsTable = pgTable(
  "acr_agent_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id").notNull(),
    agentUserId: integer("agent_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    targetScore: numeric("target_score", { precision: 5, scale: 2 }).notNull().default("80"),
    targetDeadline: date("target_deadline"),
    setByUserId: integer("set_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("acr_agent_targets_unique").on(t.ownerUserId, t.agentUserId)]
);

// 9.6 Earned achievements. Periodic achievements recur per period, so the
// uniqueness key includes earned_at_period (non-periodic ones are inserted once).
export const acrAchievementsTable = pgTable(
  "acr_achievements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id").notNull(),
    agentUserId: integer("agent_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => acrJobsTable.id, { onDelete: "set null" }),
    achievementId: text("achievement_id").notNull(),
    achievementName: text("achievement_name").notNull(),
    achievementIcon: text("achievement_icon").notNull(),
    description: text("description"),
    earnedAtPeriod: text("earned_at_period").notNull(),
    earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("acr_achievements_agent_idx").on(t.ownerUserId, t.agentUserId),
    uniqueIndex("acr_achievements_unique").on(
      t.ownerUserId,
      t.agentUserId,
      t.achievementId,
      t.earnedAtPeriod
    ),
  ]
);

// 9.3 Agent groups / shifts for cross-team benchmarking.
export const acrTeamGroupsTable = pgTable(
  "acr_team_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id").notNull(),
    name: text("name").notNull(),
    scheduleLabel: text("schedule_label"),
    agentUserIds: integer("agent_user_ids").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("acr_team_groups_owner_idx").on(t.ownerUserId)]
);

// 9.2 Performance-decline alerts surfaced to supervisors after a job completes.
export const acrPerformanceAlertsTable = pgTable(
  "acr_performance_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: integer("owner_user_id").notNull(),
    agentUserId: integer("agent_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => acrJobsTable.id, { onDelete: "cascade" }),
    // 'score_drop_significant' | 'score_drop_consecutive' | 'grade_downgrade'
    // | 'red_flag_spike' | 'missed_chat_spike' | 'below_target'
    alertType: text("alert_type").notNull(),
    severity: text("severity").notNull(), // 'critical' | 'high' | 'medium'
    title: text("title").notNull(),
    description: text("description"),
    recommendation: text("recommendation"),
    affectedDimensions: text("affected_dimensions").array(),
    isRead: boolean("is_read").notNull().default(false),
    isResolved: boolean("is_resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("acr_perf_alerts_agent_idx").on(t.agentUserId, t.ownerUserId)]
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type AcrConfigRow = typeof acrConfigsTable.$inferSelect;
export type AcrJobRow = typeof acrJobsTable.$inferSelect;
export type AcrAgentScoreRow = typeof acrAgentScoresTable.$inferSelect;
export type AcrRedFlagRow = typeof acrRedFlagsTable.$inferSelect;
export type AcrConversationScoreRow = typeof acrConversationScoresTable.$inferSelect;
export type AcrNotificationRow = typeof acrNotificationsTable.$inferSelect;
export type AcrScheduleRow = typeof acrSchedulesTable.$inferSelect;
export type AcrKpiSnapshotRow = typeof acrKpiSnapshotsTable.$inferSelect;
export type AcrAgentTargetRow = typeof acrAgentTargetsTable.$inferSelect;
export type AcrAchievementRow = typeof acrAchievementsTable.$inferSelect;
export type AcrTeamGroupRow = typeof acrTeamGroupsTable.$inferSelect;
export type AcrPerformanceAlertRow = typeof acrPerformanceAlertsTable.$inferSelect;
