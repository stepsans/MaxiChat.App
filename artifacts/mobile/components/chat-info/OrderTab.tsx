import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useCreateSalesOrder,
  useDeleteSalesOrder,
  useListProducts,
  useListSalesOrders,
  useSendSalesOrder,
  useSyncSalesOrderToSheet,
  getGetChatQueryKey,
  getListSalesOrdersQueryKey,
  type Chat,
  type Product,
  type SalesOrder,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { formatRupiah, shortDateTime } from "./shared";

type BuilderItem = {
  productId: number | null;
  code: string | null;
  name: string;
  price: number;
  qty: number;
};

const PPN_RATE = 11;

export function OrderTab({
  chatId,
  chat,
  onSent,
}: {
  chatId: number;
  chat: Chat;
  onSent: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data: orders, isLoading } = useListSalesOrders(
    { chatId },
    {
      query: {
        queryKey: getListSalesOrdersQueryKey({ chatId }),
        enabled: Number.isFinite(chatId),
      },
    },
  );

  const sendOrder = useSendSalesOrder();
  const syncOrder = useSyncSalesOrderToSheet();
  const deleteOrder = useDeleteSalesOrder();
  const createOrder = useCreateSalesOrder();

  const [busyId, setBusyId] = useState<number | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const invalidateOrders = () =>
    queryClient.invalidateQueries({
      queryKey: getListSalesOrdersQueryKey({ chatId }),
    });

  const onSend = async (o: SalesOrder) => {
    setBusyId(o.id);
    try {
      await sendOrder.mutateAsync({ id: o.id });
      queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      onSent();
    } catch (e) {
      Alert.alert("Gagal", e instanceof Error ? e.message : "Gagal mengirim");
    } finally {
      setBusyId(null);
    }
  };

  const onSync = async (o: SalesOrder) => {
    setBusyId(o.id);
    try {
      await syncOrder.mutateAsync({ id: o.id });
      invalidateOrders();
      Alert.alert("Berhasil", "Order disinkronkan ke Google Sheet.");
    } catch (e) {
      Alert.alert("Gagal", e instanceof Error ? e.message : "Gagal sinkron");
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (o: SalesOrder) => {
    Alert.alert("Hapus Order", "Yakin ingin menghapus order ini?", [
      { text: "Batal", style: "cancel" },
      {
        text: "Hapus",
        style: "destructive",
        onPress: async () => {
          setBusyId(o.id);
          try {
            await deleteOrder.mutateAsync({ id: o.id });
            invalidateOrders();
          } catch (e) {
            Alert.alert(
              "Gagal",
              e instanceof Error ? e.message : "Gagal menghapus",
            );
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: SalesOrder }) => (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.orderTotal, { color: colors.foreground }]}>
          {formatRupiah(item.total)}
        </Text>
        <View style={[styles.statusChip, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
            {item.status}
          </Text>
        </View>
      </View>
      <Text style={[styles.orderSub, { color: colors.mutedForeground }]}>
        {item.items.length} item · {shortDateTime(item.createdAt)}
        {item.syncedToSheetAt ? " · tersinkron" : ""}
      </Text>
      <View style={styles.actions}>
        <ActionBtn
          icon="send"
          label="Kirim"
          loading={busyId === item.id}
          onPress={() => onSend(item)}
        />
        <ActionBtn
          icon="upload-cloud"
          label="Sheet"
          loading={busyId === item.id}
          onPress={() => onSync(item)}
        />
        <ActionBtn
          icon="trash-2"
          label="Hapus"
          destructive
          loading={busyId === item.id}
          onPress={() => onDelete(item)}
        />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => setBuilderOpen(true)}
          style={[styles.newBtn, { backgroundColor: colors.primary }]}
        >
          <Feather name="plus" size={16} color={colors.primaryForeground} />
          <Text
            style={[styles.newBtnText, { color: colors.primaryForeground }]}
          >
            Buat Order
          </Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={orders ?? []}
          keyExtractor={(o) => String(o.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Belum ada order tersimpan.
            </Text>
          }
        />
      )}

      <OrderBuilder
        visible={builderOpen}
        onClose={() => setBuilderOpen(false)}
        chat={chat}
        chatId={chatId}
        creating={createOrder.isPending}
        onSave={async (payload) => {
          try {
            await createOrder.mutateAsync({ data: payload });
            invalidateOrders();
            setBuilderOpen(false);
          } catch (e) {
            Alert.alert(
              "Gagal",
              e instanceof Error ? e.message : "Gagal menyimpan order",
            );
          }
        }}
      />
    </View>
  );
}

function ActionBtn({
  icon,
  label,
  onPress,
  loading,
  destructive,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  loading?: boolean;
  destructive?: boolean;
}) {
  const colors = useColors();
  const tint = destructive ? colors.destructive : colors.primary;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={loading}
      style={[styles.actionBtn, { borderColor: colors.border }]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <Feather name={icon} size={15} color={tint} />
      )}
      <Text style={[styles.actionText, { color: tint }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function OrderBuilder({
  visible,
  onClose,
  chat,
  chatId,
  onSave,
  creating,
}: {
  visible: boolean;
  onClose: () => void;
  chat: Chat;
  chatId: number;
  creating: boolean;
  onSave: (payload: {
    chatId: number;
    customerName: string | null;
    customerPhone: string | null;
    ppnEnabled: boolean;
    ppnIncluded: boolean;
    ppnRate: number;
    note: string | null;
    items: {
      productId: number | null;
      code: string | null;
      name: string;
      qty: number;
      price: number;
    }[];
  }) => void;
}) {
  const colors = useColors();
  const { data: products } = useListProducts();

  const [items, setItems] = useState<BuilderItem[]>([]);
  const [ppnEnabled, setPpnEnabled] = useState(false);
  const [ppnIncluded, setPpnIncluded] = useState(true);
  const [note, setNote] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  // Clear the draft whenever the builder closes (save, backdrop, or parent close),
  // so reopening never preloads a stale order.
  useEffect(() => {
    if (!visible) {
      setItems([]);
      setPpnEnabled(false);
      setPpnIncluded(true);
      setNote("");
      setPickerOpen(false);
      setPickerQuery("");
    }
  }, [visible]);

  const addProduct = (p: Product) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.productId === p.id);
      if (existing) {
        return prev.map((i) =>
          i.productId === p.id ? { ...i, qty: i.qty + 1 } : i,
        );
      }
      return [
        ...prev,
        { productId: p.id, code: p.code, name: p.name, price: p.price, qty: 1 },
      ];
    });
    setPickerOpen(false);
    setPickerQuery("");
  };

  const setQty = (idx: number, delta: number) => {
    setItems((prev) =>
      prev
        .map((i, n) => (n === idx ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty > 0),
    );
  };

  const subtotal = useMemo(
    () => items.reduce((s, i) => s + i.price * i.qty, 0),
    [items],
  );
  const ppnAmount = useMemo(() => {
    if (!ppnEnabled) return 0;
    if (ppnIncluded) return Math.round(subtotal - subtotal / (1 + PPN_RATE / 100));
    return Math.round((subtotal * PPN_RATE) / 100);
  }, [ppnEnabled, ppnIncluded, subtotal]);
  const total = ppnEnabled && !ppnIncluded ? subtotal + ppnAmount : subtotal;

  const filteredProducts = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return products ?? [];
    return (products ?? []).filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q),
    );
  }, [products, pickerQuery]);

  const save = () => {
    if (items.length === 0) {
      Alert.alert("Order kosong", "Tambahkan minimal satu produk.");
      return;
    }
    onSave({
      chatId,
      // Let the server snapshot/normalize the customer from the chat (it strips
      // non-phone identifiers like tg:/group ids); don't override with the raw key.
      customerName: null,
      customerPhone: null,
      ppnEnabled,
      ppnIncluded,
      ppnRate: PPN_RATE,
      note: note.trim() || null,
      items: items.map((i) => ({
        productId: i.productId,
        code: i.code,
        name: i.name,
        qty: i.qty,
        price: i.price,
      })),
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
      presentationStyle="formSheet"
    >
      <View style={[styles.builder, { backgroundColor: colors.background }]}>
        <View style={[styles.builderHead, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[styles.cancel, { color: colors.mutedForeground }]}>
              Batal
            </Text>
          </TouchableOpacity>
          <Text style={[styles.builderTitle, { color: colors.foreground }]}>
            Order Baru
          </Text>
          <TouchableOpacity onPress={save} disabled={creating}>
            <Text style={[styles.save, { color: colors.primary }]}>
              {creating ? "…" : "Simpan"}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.builderBody}>
          {items.map((i, idx) => (
            <View
              key={`${i.productId}-${idx}`}
              style={[styles.lineItem, { borderColor: colors.border }]}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={[styles.lineName, { color: colors.foreground }]}
                  numberOfLines={1}
                >
                  {i.name}
                </Text>
                <Text style={[styles.linePrice, { color: colors.mutedForeground }]}>
                  {formatRupiah(i.price)} × {i.qty} ={" "}
                  {formatRupiah(i.price * i.qty)}
                </Text>
              </View>
              <View style={styles.qtyBox}>
                <TouchableOpacity
                  onPress={() => setQty(idx, -1)}
                  style={[styles.qtyBtn, { backgroundColor: colors.secondary }]}
                >
                  <Feather name="minus" size={14} color={colors.foreground} />
                </TouchableOpacity>
                <Text style={[styles.qtyText, { color: colors.foreground }]}>
                  {i.qty}
                </Text>
                <TouchableOpacity
                  onPress={() => setQty(idx, 1)}
                  style={[styles.qtyBtn, { backgroundColor: colors.secondary }]}
                >
                  <Feather name="plus" size={14} color={colors.foreground} />
                </TouchableOpacity>
              </View>
            </View>
          ))}

          <TouchableOpacity
            onPress={() => setPickerOpen(true)}
            style={[styles.addItemBtn, { borderColor: colors.primary }]}
          >
            <Feather name="plus" size={16} color={colors.primary} />
            <Text style={[styles.addItemText, { color: colors.primary }]}>
              Tambah Produk
            </Text>
          </TouchableOpacity>

          {/* PPN */}
          <View style={[styles.optRow, { marginTop: 18 }]}>
            <Text style={[styles.optLabel, { color: colors.foreground }]}>
              PPN {PPN_RATE}%
            </Text>
            <Switch
              value={ppnEnabled}
              onValueChange={setPpnEnabled}
              trackColor={{ true: colors.primary, false: colors.muted }}
            />
          </View>
          {ppnEnabled ? (
            <View style={styles.optRow}>
              <Text style={[styles.optLabel, { color: colors.mutedForeground }]}>
                Harga sudah termasuk PPN
              </Text>
              <Switch
                value={ppnIncluded}
                onValueChange={setPpnIncluded}
                trackColor={{ true: colors.primary, false: colors.muted }}
              />
            </View>
          ) : null}

          {/* Note */}
          <Text style={[styles.optLabel, { color: colors.mutedForeground, marginTop: 16 }]}>
            Catatan
          </Text>
          <TextInput
            style={[
              styles.noteInput,
              { backgroundColor: colors.secondary, color: colors.foreground },
            ]}
            value={note}
            onChangeText={setNote}
            placeholder="Opsional"
            placeholderTextColor={colors.mutedForeground}
            multiline
          />

          {/* Totals */}
          <View style={[styles.totals, { borderTopColor: colors.border }]}>
            <TotalRow label="Subtotal" value={subtotal} />
            {ppnEnabled ? <TotalRow label={`PPN ${PPN_RATE}%`} value={ppnAmount} /> : null}
            <TotalRow label="Total" value={total} bold />
          </View>
        </ScrollView>

        {/* Product picker */}
        <Modal
          visible={pickerOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setPickerOpen(false)}
        >
          <Pressable
            style={styles.pickerBackdrop}
            onPress={() => setPickerOpen(false)}
          >
            <Pressable
              style={[styles.pickerSheet, { backgroundColor: colors.background }]}
            >
              <View
                style={[styles.search, { backgroundColor: colors.secondary }]}
              >
                <Feather name="search" size={16} color={colors.mutedForeground} />
                <TextInput
                  style={[styles.searchInput, { color: colors.foreground }]}
                  placeholder="Cari produk"
                  placeholderTextColor={colors.mutedForeground}
                  value={pickerQuery}
                  onChangeText={setPickerQuery}
                  autoFocus
                />
              </View>
              <FlatList
                data={filteredProducts}
                keyExtractor={(p) => String(p.id)}
                keyboardShouldPersistTaps="handled"
                style={{ marginTop: 8 }}
                renderItem={({ item: p }) => (
                  <TouchableOpacity
                    onPress={() => addProduct(p)}
                    style={[styles.pickRow, { borderColor: colors.border }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[styles.lineName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {p.name}
                      </Text>
                      <Text
                        style={[styles.linePrice, { color: colors.mutedForeground }]}
                      >
                        {p.code} · {formatRupiah(p.price)}
                      </Text>
                    </View>
                    <Feather name="plus-circle" size={20} color={colors.primary} />
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                    Tidak ada produk.
                  </Text>
                }
              />
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}

function TotalRow({
  label,
  value,
  bold,
}: {
  label: string;
  value: number;
  bold?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.totalRow}>
      <Text
        style={[
          bold ? styles.totalLabelBold : styles.totalLabel,
          { color: bold ? colors.foreground : colors.mutedForeground },
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          bold ? styles.totalLabelBold : styles.totalLabel,
          { color: bold ? colors.primary : colors.foreground },
        ]}
      >
        {formatRupiah(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { padding: 12, paddingBottom: 6 },
  newBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    paddingVertical: 11,
  },
  newBtnText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  list: { padding: 12, paddingTop: 6, paddingBottom: 48 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  orderTotal: { fontFamily: "Inter_700Bold", fontSize: 16 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  orderSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 4 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
  },
  // Builder
  builder: { flex: 1 },
  builderHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  builderTitle: { fontFamily: "Inter_700Bold", fontSize: 16 },
  cancel: { fontFamily: "Inter_500Medium", fontSize: 15 },
  save: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  builderBody: { padding: 16, paddingBottom: 48 },
  lineItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lineName: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  linePrice: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  qtyBox: { flexDirection: "row", alignItems: "center", gap: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    minWidth: 20,
    textAlign: "center",
  },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    marginTop: 12,
  },
  addItemText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  optRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  optLabel: { fontFamily: "Inter_500Medium", fontSize: 14 },
  noteInput: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    minHeight: 60,
    marginTop: 6,
  },
  totals: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 18,
    paddingTop: 12,
    gap: 6,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { fontFamily: "Inter_400Regular", fontSize: 14 },
  totalLabelBold: { fontFamily: "Inter_700Bold", fontSize: 16 },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  pickerSheet: {
    height: "80%",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 15 },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
