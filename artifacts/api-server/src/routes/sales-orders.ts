import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { google } from "googleapis";
import { z } from "zod";
import {
  db,
  salesOrdersTable,
  salesOrderItemsTable,
  salesOrderSyncConfigTable,
  chatsTable,
  channelsTable,
  chatMessagesTable,
  credentialsTable,
  type SalesOrder,
  type SalesOrderItem,
  type SalesOrderSyncConfig,
} from "@workspace/db";
import { requireOwnerUserId } from "../lib/channel-context";
import { getCurrentOwnerPhone, getActiveSocket } from "./whatsapp";
import { getAuthorizedOAuthClient } from "./credentials";
import { sendMessage as tgSendMessage } from "../lib/telegram";
import { withTag, resolveAgentTag } from "../lib/sender-tag.js";

const router = Router();

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

// ---- Input validation ------------------------------------------------------

const DiscountType = z.enum(["percent", "amount"]);

// A percent discount can never exceed 100%; a nominal discount is bounded only
// by the sane price ceiling. The compute path also clamps to the base, but we
// reject nonsensical values up front so persisted data stays meaningful.
function percentBounded<
  T extends { discountType?: "percent" | "amount"; discountValue?: number },
>(obj: T, ctx: z.RefinementCtx) {
  if (obj.discountType === "percent" && (obj.discountValue ?? 0) > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discountValue"],
      message: "Diskon persen tidak boleh lebih dari 100",
    });
  }
}

const ItemInput = z
  .object({
    productId: z.number().int().positive().nullable().optional(),
    code: z.string().nullable().optional(),
    name: z.string().min(1).max(500),
    qty: z.number().int().min(1).max(1_000_000),
    price: z.number().int().min(0).max(1_000_000_000),
    discountType: DiscountType.optional(),
    discountValue: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .superRefine(percentBounded);

const OrderInput = z
  .object({
    chatId: z.number().int().positive().nullable().optional(),
    customerName: z.string().max(500).nullable().optional(),
    customerPhone: z.string().max(100).nullable().optional(),
    ppnEnabled: z.boolean().optional(),
    ppnIncluded: z.boolean().optional(),
    ppnRate: z.number().int().min(0).max(100).optional(),
    discountType: DiscountType.optional(),
    discountValue: z.number().int().min(0).max(1_000_000_000).optional(),
    note: z.string().max(2000).nullable().optional(),
    items: z.array(ItemInput).min(1).max(200),
  })
  .superRefine(percentBounded);

type ParsedOrder = z.infer<typeof OrderInput>;

// ---- Money / PPN math (server-authoritative) -------------------------------

// Resolve a discount (percent or nominal) to a Rupiah amount, clamped so it can
// never exceed the base it applies to nor go negative.
function discountFor(
  type: string | null | undefined,
  value: number | null | undefined,
  base: number
): number {
  if (!value || value <= 0 || base <= 0) return 0;
  const amount = type === "percent" ? Math.round((base * value) / 100) : value;
  return Math.min(Math.max(0, amount), base);
}

// See the schema comment on salesOrdersTable for the PPN cases. Discounts apply
// before PPN: each line's discount comes off its gross (qty*price), and the
// global discount comes off the resulting subtotal.
function computeTotals(
  items: {
    qty: number;
    price: number;
    discountType?: string | null;
    discountValue?: number | null;
  }[],
  ppnEnabled: boolean,
  ppnIncluded: boolean,
  ppnRate: number,
  globalDiscountType: string,
  globalDiscountValue: number
): {
  lineTotals: number[];
  subtotal: number;
  discountAmount: number;
  ppnAmount: number;
  total: number;
} {
  const lineTotals = items.map((it) => {
    const gross = it.qty * it.price;
    return Math.max(
      0,
      gross - discountFor(it.discountType, it.discountValue, gross)
    );
  });
  const subtotal = lineTotals.reduce((s, n) => s + n, 0);
  const discountAmount = discountFor(
    globalDiscountType,
    globalDiscountValue,
    subtotal
  );
  const base = Math.max(0, subtotal - discountAmount);
  let ppnAmount = 0;
  let total = base;
  if (ppnEnabled && ppnRate > 0) {
    if (ppnIncluded) {
      const net = Math.round(base / (1 + ppnRate / 100));
      ppnAmount = base - net;
      total = base;
    } else {
      ppnAmount = Math.round((base * ppnRate) / 100);
      total = base + ppnAmount;
    }
  }
  return { lineTotals, subtotal, discountAmount, ppnAmount, total };
}

// ---- Serialization ---------------------------------------------------------

function serializeItem(row: SalesOrderItem) {
  return {
    id: row.id,
    productId: row.productId ?? null,
    code: row.code ?? null,
    name: row.name,
    qty: row.qty,
    price: row.price,
    discountType: row.discountType as "percent" | "amount",
    discountValue: row.discountValue,
    lineTotal: row.lineTotal,
  };
}

function serializeOrder(order: SalesOrder, items: SalesOrderItem[]) {
  return {
    id: order.id,
    chatId: order.chatId ?? null,
    customerName: order.customerName ?? null,
    customerPhone: order.customerPhone ?? null,
    ppnEnabled: order.ppnEnabled,
    ppnIncluded: order.ppnIncluded,
    ppnRate: order.ppnRate,
    subtotal: order.subtotal,
    discountType: order.discountType as "percent" | "amount",
    discountValue: order.discountValue,
    discountAmount: order.discountAmount,
    ppnAmount: order.ppnAmount,
    total: order.total,
    note: order.note ?? null,
    status: order.status as "draft" | "sent",
    syncedToSheetAt: order.syncedToSheetAt
      ? order.syncedToSheetAt.toISOString()
      : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: items
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map(serializeItem),
  };
}

// Resolve the chat (with channel) only if it belongs to the owner's tenant.
// Returns null when the chat doesn't exist or belongs to another user.
async function loadOwnedChatForUser(chatId: number, ownerUserId: number) {
  const [row] = await db
    .select({ chat: chatsTable, channel: channelsTable })
    .from(chatsTable)
    .innerJoin(channelsTable, eq(chatsTable.channelId, channelsTable.id))
    .where(
      and(eq(chatsTable.id, chatId), eq(channelsTable.userId, ownerUserId))
    )
    .limit(1);
  return row ?? null;
}

async function loadOrderWithItems(
  orderId: number,
  ownerUserId: number
): Promise<{ order: SalesOrder; items: SalesOrderItem[] } | null> {
  const [order] = await db
    .select()
    .from(salesOrdersTable)
    .where(
      and(
        eq(salesOrdersTable.id, orderId),
        eq(salesOrdersTable.userId, ownerUserId)
      )
    )
    .limit(1);
  if (!order) return null;
  const items = await db
    .select()
    .from(salesOrderItemsTable)
    .where(eq(salesOrderItemsTable.orderId, orderId));
  return { order, items };
}

// Insert the order's line items, snapshotting computed line totals.
async function insertItems(orderId: number, parsed: ParsedOrder) {
  const { lineTotals } = computeTotals(
    parsed.items,
    parsed.ppnEnabled ?? false,
    parsed.ppnIncluded ?? true,
    parsed.ppnRate ?? 11,
    parsed.discountType ?? "amount",
    parsed.discountValue ?? 0
  );
  await db.insert(salesOrderItemsTable).values(
    parsed.items.map((it, idx) => ({
      orderId,
      productId: it.productId ?? null,
      code: it.code ?? null,
      name: it.name,
      qty: it.qty,
      price: it.price,
      discountType: it.discountType ?? "amount",
      discountValue: it.discountValue ?? 0,
      lineTotal: lineTotals[idx]!,
      sortOrder: idx,
    }))
  );
}

// ---- Sync config (must be registered BEFORE the /:id routes) ---------------

function publicSyncConfig(row: SalesOrderSyncConfig) {
  return {
    id: row.id,
    credentialId: row.credentialId,
    spreadsheetId: row.spreadsheetId,
    sheetName: row.sheetName,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastSyncStatus: row.lastSyncStatus as "idle" | "ok" | "error",
    lastSyncError: row.lastSyncError ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/sync-config", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.json({ config: null });
      return;
    }
    const [row] = await db
      .select()
      .from(salesOrderSyncConfigTable)
      .where(
        and(
          eq(salesOrderSyncConfigTable.userId, userId),
          eq(salesOrderSyncConfigTable.ownerPhone, ownerPhone)
        )
      )
      .limit(1);
    res.json({ config: row ? publicSyncConfig(row) : null });
  } catch (err) {
    req.log.error({ err }, "get sales-order sync config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const SyncConfigInput = z.object({
  credentialId: z.number().int().positive(),
  spreadsheetId: z.string().min(1),
  sheetName: z.string().min(1),
});

router.put("/sync-config", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(503).json({ error: "Hubungkan WhatsApp dulu." });
      return;
    }
    if (req.body === null) {
      await db
        .delete(salesOrderSyncConfigTable)
        .where(
          and(
            eq(salesOrderSyncConfigTable.userId, userId),
            eq(salesOrderSyncConfigTable.ownerPhone, ownerPhone)
          )
        );
      res.json({ config: null });
      return;
    }
    const parsed = SyncConfigInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const [cred] = await db
      .select()
      .from(credentialsTable)
      .where(
        and(
          eq(credentialsTable.id, parsed.data.credentialId),
          eq(credentialsTable.userId, userId)
        )
      )
      .limit(1);
    if (!cred) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    const values = {
      userId,
      ownerPhone,
      credentialId: parsed.data.credentialId,
      spreadsheetId: parsed.data.spreadsheetId,
      sheetName: parsed.data.sheetName,
      updatedAt: new Date(),
    };
    const upserted = await db
      .insert(salesOrderSyncConfigTable)
      .values(values)
      .onConflictDoUpdate({
        target: salesOrderSyncConfigTable.ownerPhone,
        set: values,
      })
      .returning();
    res.json({ config: publicSyncConfig(upserted[0]!) });
  } catch (err) {
    req.log.error({ err }, "upsert sales-order sync config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- CRUD ------------------------------------------------------------------

router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    const chatIdRaw = req.query.chatId;
    const chatId =
      chatIdRaw != null && chatIdRaw !== ""
        ? Number(chatIdRaw)
        : null;
    if (chatId != null && (!Number.isInteger(chatId) || chatId <= 0)) {
      res.status(400).json({ error: "Invalid chatId" });
      return;
    }

    const where =
      chatId != null
        ? and(
            eq(salesOrdersTable.userId, ownerUserId),
            eq(salesOrdersTable.chatId, chatId)
          )
        : eq(salesOrdersTable.userId, ownerUserId);
    const orders = await db
      .select()
      .from(salesOrdersTable)
      .where(where)
      .orderBy(desc(salesOrdersTable.createdAt));

    if (orders.length === 0) {
      res.json([]);
      return;
    }
    // Batch-load line items only for the returned orders.
    const ids = orders.map((o) => o.id);
    const allItems = await db
      .select()
      .from(salesOrderItemsTable)
      .where(inArray(salesOrderItemsTable.orderId, ids));
    const byOrder = new Map<number, SalesOrderItem[]>();
    for (const it of allItems) {
      const arr = byOrder.get(it.orderId) ?? [];
      arr.push(it);
      byOrder.set(it.orderId, arr);
    }
    res.json(orders.map((o) => serializeOrder(o, byOrder.get(o.id) ?? [])));
  } catch (err) {
    req.log.error({ err }, "list sales orders failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    const parsed = OrderInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const data = parsed.data;

    // Validate + snapshot the chat (if linked).
    let chatId: number | null = null;
    let customerName = data.customerName ?? null;
    let customerPhone = data.customerPhone ?? null;
    if (data.chatId != null) {
      const owned = await loadOwnedChatForUser(data.chatId, ownerUserId);
      if (!owned) {
        res.status(404).json({ error: "Chat tidak ditemukan" });
        return;
      }
      chatId = owned.chat.id;
      if (!customerName) {
        customerName =
          owned.chat.nickname || owned.chat.contactName || null;
      }
      if (!customerPhone) {
        customerPhone = owned.chat.phoneNumber.startsWith("tg:")
          ? null
          : owned.chat.phoneNumber;
      }
    }

    const ppnEnabled = data.ppnEnabled ?? false;
    const ppnIncluded = data.ppnIncluded ?? true;
    const ppnRate = data.ppnRate ?? 11;
    const discountType = data.discountType ?? "amount";
    const discountValue = data.discountValue ?? 0;
    const { subtotal, discountAmount, ppnAmount, total } = computeTotals(
      data.items,
      ppnEnabled,
      ppnIncluded,
      ppnRate,
      discountType,
      discountValue
    );

    const [order] = await db
      .insert(salesOrdersTable)
      .values({
        userId: ownerUserId,
        chatId,
        customerName,
        customerPhone,
        ppnEnabled,
        ppnIncluded,
        ppnRate,
        subtotal,
        discountType,
        discountValue,
        discountAmount,
        ppnAmount,
        total,
        note: data.note ?? null,
        status: "draft",
      })
      .returning();
    await insertItems(order!.id, data);

    const loaded = await loadOrderWithItems(order!.id, ownerUserId);
    res.status(201).json(serializeOrder(loaded!.order, loaded!.items));
  } catch (err) {
    req.log.error({ err }, "create sales order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const loaded = await loadOrderWithItems(id, ownerUserId);
    if (!loaded) {
      res.status(404).json({ error: "Order tidak ditemukan" });
      return;
    }
    res.json(serializeOrder(loaded.order, loaded.items));
  } catch (err) {
    req.log.error({ err }, "get sales order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const existing = await loadOrderWithItems(id, ownerUserId);
    if (!existing) {
      res.status(404).json({ error: "Order tidak ditemukan" });
      return;
    }
    const parsed = OrderInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const data = parsed.data;

    let chatId: number | null = existing.order.chatId ?? null;
    let customerName = data.customerName ?? existing.order.customerName ?? null;
    let customerPhone =
      data.customerPhone ?? existing.order.customerPhone ?? null;
    if (data.chatId != null) {
      const owned = await loadOwnedChatForUser(data.chatId, ownerUserId);
      if (!owned) {
        res.status(404).json({ error: "Chat tidak ditemukan" });
        return;
      }
      chatId = owned.chat.id;
    }

    const ppnEnabled = data.ppnEnabled ?? false;
    const ppnIncluded = data.ppnIncluded ?? true;
    const ppnRate = data.ppnRate ?? 11;
    const discountType = data.discountType ?? "amount";
    const discountValue = data.discountValue ?? 0;
    const { subtotal, discountAmount, ppnAmount, total } = computeTotals(
      data.items,
      ppnEnabled,
      ppnIncluded,
      ppnRate,
      discountType,
      discountValue
    );

    await db
      .update(salesOrdersTable)
      .set({
        chatId,
        customerName,
        customerPhone,
        ppnEnabled,
        ppnIncluded,
        ppnRate,
        subtotal,
        discountType,
        discountValue,
        discountAmount,
        ppnAmount,
        total,
        note: data.note ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.userId, ownerUserId)
        )
      );
    // Replace line items wholesale.
    await db
      .delete(salesOrderItemsTable)
      .where(eq(salesOrderItemsTable.orderId, id));
    await insertItems(id, data);

    const loaded = await loadOrderWithItems(id, ownerUserId);
    res.json(serializeOrder(loaded!.order, loaded!.items));
  } catch (err) {
    req.log.error({ err }, "update sales order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const deleted = await db
      .delete(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, id),
          eq(salesOrdersTable.userId, ownerUserId)
        )
      )
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Order tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete sales order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Send order summary to the customer's chat -----------------------------

// Build the customer-facing order summary. NEVER includes internal-only data
// (stock, internal price tiers): line items only carry name/qty/unit-price.
function buildOrderSummaryText(
  order: SalesOrder,
  items: SalesOrderItem[]
): string {
  const lines: string[] = ["*Ringkasan Pesanan*", ""];
  const sorted = items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  sorted.forEach((it, idx) => {
    lines.push(
      `${idx + 1}. ${it.name}`,
      `   ${it.qty} x ${formatRupiah(it.price)} = ${formatRupiah(it.lineTotal)}`
    );
  });
  lines.push("", `Subtotal: ${formatRupiah(order.subtotal)}`);
  if (order.discountAmount > 0) {
    const label =
      order.discountType === "percent"
        ? `Diskon ${order.discountValue}%`
        : "Diskon";
    lines.push(`${label}: -${formatRupiah(order.discountAmount)}`);
  }
  if (order.ppnEnabled) {
    lines.push(
      `PPN ${order.ppnRate}%${order.ppnIncluded ? " (termasuk)" : ""}: ${formatRupiah(order.ppnAmount)}`
    );
  }
  lines.push(`*Total: ${formatRupiah(order.total)}*`);
  if (order.note) {
    lines.push("", `Catatan: ${order.note}`);
  }
  return lines.join("\n");
}

router.post("/:id/send", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const loaded = await loadOrderWithItems(id, ownerUserId);
    if (!loaded) {
      res.status(404).json({ error: "Order tidak ditemukan" });
      return;
    }
    const { order, items } = loaded;
    if (order.chatId == null) {
      res
        .status(400)
        .json({ error: "Order ini tidak terhubung ke chat manapun." });
      return;
    }
    const owned = await loadOwnedChatForUser(order.chatId, ownerUserId);
    if (!owned) {
      res.status(404).json({ error: "Chat tidak ditemukan" });
      return;
    }
    const { chat, channel } = owned;

    const agentTag = await resolveAgentTag(userId);
    const text = withTag(buildOrderSummaryText(order, items), agentTag);

    let dedupeKey: string | null = null;
    if (channel.kind === "telegram") {
      const meta = (channel.metadata as Record<string, unknown> | null)?.[
        "telegram"
      ] as { botToken?: string } | undefined;
      const tgChatId = chat.phoneNumber.startsWith("tg:")
        ? Number.parseInt(chat.phoneNumber.slice(3), 10)
        : NaN;
      if (!meta?.botToken || !Number.isFinite(tgChatId)) {
        res
          .status(400)
          .json({ error: "Channel Telegram belum terhubung." });
        return;
      }
      try {
        const sent = await tgSendMessage(meta.botToken, tgChatId, text);
        dedupeKey = `tg:${tgChatId}:${sent.messageId}`;
      } catch (err) {
        req.log.error({ err, orderId: id }, "telegram order send failed");
        res.status(502).json({ error: "Gagal kirim ke Telegram" });
        return;
      }
    } else {
      const sock = await getActiveSocket(userId);
      if (!sock) {
        res.status(503).json({ error: "WhatsApp belum terhubung" });
        return;
      }
      const jid = chat.phoneNumber.includes("@")
        ? chat.phoneNumber
        : `${chat.phoneNumber.replace(/[^\d]/g, "")}@s.whatsapp.net`;
      try {
        // Capture the WA message id so the Baileys echo (messages.upsert)
        // dedupes against our own insert below and we don't double-record it.
        const sent = await sock.sendMessage(jid, { text });
        dedupeKey = sent?.key?.id ?? null;
      } catch (err) {
        req.log.error({ err, orderId: id }, "whatsapp order send failed");
        res.status(500).json({ error: "Gagal kirim ke WhatsApp" });
        return;
      }
    }

    // Record the outbound message + bump the chat preview (mirrors /reply).
    await db
      .insert(chatMessagesTable)
      .values({
        chatId: order.chatId,
        direction: "outbound",
        content: text,
        isAiGenerated: false,
        waMessageId: dedupeKey,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId });
    await db
      .update(chatsTable)
      .set({ lastMessage: text, lastMessageAt: new Date() })
      .where(eq(chatsTable.id, order.chatId));

    await db
      .update(salesOrdersTable)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(salesOrdersTable.id, id));

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "send sales order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Append the order to the configured Google Sheet -----------------------

router.post("/:id/sync-sheet", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const loaded = await loadOrderWithItems(id, ownerUserId);
    if (!loaded) {
      res.status(404).json({ error: "Order tidak ditemukan" });
      return;
    }
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(503).json({ error: "Hubungkan WhatsApp dulu." });
      return;
    }
    const [cfg] = await db
      .select()
      .from(salesOrderSyncConfigTable)
      .where(
        and(
          eq(salesOrderSyncConfigTable.userId, userId),
          eq(salesOrderSyncConfigTable.ownerPhone, ownerPhone)
        )
      )
      .limit(1);
    if (!cfg) {
      res
        .status(400)
        .json({ error: "Google Sheet untuk sales order belum dikonfigurasi." });
      return;
    }
    const [cred] = await db
      .select()
      .from(credentialsTable)
      .where(
        and(
          eq(credentialsTable.id, cfg.credentialId),
          eq(credentialsTable.userId, userId)
        )
      )
      .limit(1);
    if (!cred) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    if (cred.status !== "connected") {
      res
        .status(400)
        .json({ error: "Credential belum terhubung. Reconnect dulu." });
      return;
    }

    const { order, items } = loaded;
    const sorted = items
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const itemsSummary = sorted
      .map((it) => `${it.qty}x ${it.name} @${it.price}`)
      .join("; ");
    const HEADER = [
      "Tanggal",
      "No Order",
      "Customer",
      "No HP",
      "Items",
      "Subtotal",
      "Diskon",
      "PPN",
      "Total",
      "Status",
      "Catatan",
    ];
    const row = [
      new Date().toISOString(),
      String(order.id),
      order.customerName ?? "",
      order.customerPhone ?? "",
      itemsSummary,
      order.subtotal,
      order.discountAmount,
      order.ppnEnabled ? order.ppnAmount : 0,
      order.total,
      order.status,
      order.note ?? "",
    ];

    try {
      const auth = await getAuthorizedOAuthClient(cred);
      const sheets = google.sheets({ version: "v4", auth });
      // Seed a header row if the tab is currently empty.
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.spreadsheetId,
        range: `${cfg.sheetName}!A1:A1`,
      });
      const isEmpty = (existing.data.values ?? []).length === 0;
      const values = isEmpty ? [HEADER, row] : [row];
      await sheets.spreadsheets.values.append({
        spreadsheetId: cfg.spreadsheetId,
        range: cfg.sheetName,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
    } catch (err: unknown) {
      const e = err as {
        message?: string;
        code?: number;
        status?: number;
        response?: { status?: number; data?: { error?: { message?: string } } };
      };
      req.log.error({ err, orderId: id }, "sales-order sheet append failed");
      const httpStatus = e.code ?? e.status ?? e.response?.status;
      const apiMessage = e.response?.data?.error?.message ?? e.message ?? "";
      // Only a genuine token/scope failure is fixed by reconnecting. The most
      // common one: the connected token was granted only the old read-only
      // scope, so reads work but the write (append) is rejected with
      // "insufficient authentication scopes". Detect these explicitly (not just
      // any 401/403) so a spreadsheet-sharing 403 doesn't wrongly flag a
      // healthy credential — upgrading the DB scope list never expands an
      // already-granted token; the user must Reconnect to re-consent.
      const isAuthScopeError =
        httpStatus === 401 ||
        /insufficient.*scope|insufficient authentication|access_token_scope_insufficient|invalid_grant|invalid_token|invalid authentication credentials|unauthorized/i.test(
          apiMessage
        );
      // A 403/permission failure without an auth signal means the spreadsheet
      // simply isn't shared with the connected Google account.
      const isAclError =
        !isAuthScopeError &&
        (httpStatus === 403 ||
          /permission|forbidden|does not have access/i.test(apiMessage));
      let userError: string;
      if (isAuthScopeError) {
        userError =
          "Izin tulis ke Google Sheet belum diberikan. Buka halaman Credentials, klik Reconnect pada credential Google untuk memberi akses tulis (write), lalu coba simpan lagi.";
      } else if (isAclError) {
        userError =
          "Akun Google tidak punya akses ke spreadsheet ini. Bagikan (share) spreadsheet ke akun Google yang terhubung dengan izin Editor, lalu coba lagi.";
      } else {
        userError = "Gagal menulis ke Google Sheet. Cek koneksi/izin.";
      }
      await db
        .update(salesOrderSyncConfigTable)
        .set({
          lastSyncStatus: "error",
          lastSyncError: apiMessage || "Gagal menulis ke Sheet",
          updatedAt: new Date(),
        })
        .where(eq(salesOrderSyncConfigTable.id, cfg.id));
      // Flag the credential for reconnect ONLY on a real token/scope failure,
      // so we never degrade a healthy credential over a sharing (ACL) error.
      if (isAuthScopeError) {
        await db
          .update(credentialsTable)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(credentialsTable.id, cred.id));
      }
      res.status(502).json({ error: userError });
      return;
    }

    const now = new Date();
    await db
      .update(salesOrderSyncConfigTable)
      .set({ lastSyncedAt: now, lastSyncStatus: "ok", lastSyncError: null, updatedAt: now })
      .where(eq(salesOrderSyncConfigTable.id, cfg.id));
    await db
      .update(salesOrdersTable)
      .set({ syncedToSheetAt: now, updatedAt: now })
      .where(eq(salesOrdersTable.id, id));

    res.json({ ok: true, syncedAt: now.toISOString() });
  } catch (err) {
    req.log.error({ err }, "sync sales order to sheet failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
