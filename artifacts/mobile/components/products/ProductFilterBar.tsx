import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import {
  NO_CATEGORY,
  type ProductFilterState,
  type ProductSortKey,
} from "./useProductFilter";

const SORT_LABELS: { key: ProductSortKey; label: string }[] = [
  { key: "price", label: "Harga" },
  { key: "code", label: "Kode" },
  { key: "name", label: "Nama" },
  { key: "stock", label: "Stok" },
];

/**
 * Reusable filter strip for product lists: search, category combo box,
 * "jumlah > 0" toggle, sort key, and ascending/descending direction. `compact`
 * trims paddings for the narrower in-chat sidebar.
 */
export function ProductFilterBar({
  state,
  compact,
}: {
  state: ProductFilterState;
  compact?: boolean;
}) {
  const colors = useColors();
  const [catOpen, setCatOpen] = useState(false);

  const categoryLabel =
    state.category === NO_CATEGORY
      ? "Tanpa kategori"
      : state.category ?? "Semua kategori";

  const catOptions: { value: string | null; label: string }[] = [
    { value: null, label: "Semua kategori" },
    ...state.categories.map((c) => ({ value: c, label: c })),
    { value: NO_CATEGORY, label: "Tanpa kategori" },
  ];

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={styles.row}>
        <View style={[styles.search, { backgroundColor: colors.secondary }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Cari nama / kode"
            placeholderTextColor={colors.mutedForeground}
            value={state.query}
            onChangeText={state.setQuery}
          />
        </View>
      </View>

      <View style={styles.row}>
        <TouchableOpacity
          onPress={() => setCatOpen(true)}
          style={[
            styles.combo,
            { backgroundColor: colors.secondary, borderColor: colors.border },
          ]}
        >
          <Text
            style={[styles.comboText, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {categoryLabel}
          </Text>
          <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => state.setQtyInStock(!state.qtyInStock)}
          style={[
            styles.checkbox,
            {
              backgroundColor: state.qtyInStock ? colors.success : colors.secondary,
              borderColor: state.qtyInStock ? colors.success : colors.border,
            },
          ]}
        >
          <Feather
            name="check"
            size={13}
            color={state.qtyInStock ? "#ffffff" : colors.mutedForeground}
          />
          <Text
            style={[
              styles.checkboxText,
              { color: state.qtyInStock ? "#ffffff" : colors.mutedForeground },
            ]}
          >
            Jumlah &gt; 0
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <View style={styles.sortGroup}>
          {SORT_LABELS.map((s) => {
            const active = state.sortKey === s.key;
            return (
              <TouchableOpacity
                key={s.key}
                onPress={() => state.setSortKey(s.key)}
                style={[
                  styles.sortChip,
                  {
                    backgroundColor: active ? colors.primary : colors.secondary,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.sortText,
                    { color: active ? colors.primaryForeground : colors.mutedForeground },
                  ]}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          onPress={() => state.setAsc(!state.asc)}
          style={[styles.dirBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          accessibilityLabel={state.asc ? "Urut naik" : "Urut turun"}
        >
          <Feather
            name={state.asc ? "arrow-up" : "arrow-down"}
            size={16}
            color={colors.foreground}
          />
        </TouchableOpacity>
      </View>

      <Modal visible={catOpen} transparent animationType="fade" onRequestClose={() => setCatOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCatOpen(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.card }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Kategori</Text>
            <FlatList
              data={catOptions}
              keyExtractor={(o) => o.value ?? "__all"}
              renderItem={({ item }) => {
                const active = state.category === item.value;
                return (
                  <TouchableOpacity
                    style={styles.optRow}
                    onPress={() => {
                      state.setCategory(item.value);
                      setCatOpen(false);
                    }}
                  >
                    <Text style={[styles.optText, { color: colors.foreground }]}>
                      {item.label}
                    </Text>
                    {active ? (
                      <Feather name="check" size={18} color={colors.primary} />
                    ) : null}
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  wrapCompact: { paddingHorizontal: 10, paddingTop: 8, gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 15, padding: 0 },
  combo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    height: 40,
  },
  comboText: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 13 },
  checkbox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    height: 40,
  },
  checkboxText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  sortGroup: { flex: 1, flexDirection: "row", gap: 6 },
  sortChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    height: 34,
  },
  sortText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  dirBtn: {
    width: 40,
    height: 34,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 32,
  },
  sheet: { borderRadius: 16, padding: 16, maxHeight: "70%" },
  sheetTitle: { fontFamily: "Inter_700Bold", fontSize: 16, marginBottom: 8 },
  optRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  optText: { fontFamily: "Inter_400Regular", fontSize: 15 },
});
