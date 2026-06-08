import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useListProducts,
  useSendProductToChat,
  getGetChatQueryKey,
  type Product,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl } from "@/lib/api";
import { formatRupiah } from "./shared";

export function ProdukTab({
  chatId,
  onSent,
}: {
  chatId: number;
  onSent: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { data: products, isLoading } = useListProducts();
  const send = useSendProductToChat();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [sendingId, setSendingId] = useState<number | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products ?? []) if (p.category) set.add(p.category);
    return Array.from(set).sort();
  }, [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (products ?? []).filter((p) => {
      if (category && p.category !== category) return false;
      if (inStockOnly) {
        const stock = p.stockOnHand ?? p.stock ?? 0;
        if (stock <= 0) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)
      );
    });
  }, [products, query, category, inStockOnly]);

  const onSend = async (p: Product) => {
    setSendingId(p.id);
    try {
      await send.mutateAsync({ id: chatId, data: { productId: p.id } });
      queryClient.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
      onSent();
    } catch (e) {
      Alert.alert("Gagal", e instanceof Error ? e.message : "Gagal mengirim");
    } finally {
      setSendingId(null);
    }
  };

  const renderItem = ({ item }: { item: Product }) => {
    const uri = resolveMediaUrl(item.imageUrl);
    const stock = item.stockOnHand ?? item.stock;
    return (
      <View style={[styles.card, { borderColor: colors.border }]}>
        <View style={[styles.thumb, { backgroundColor: colors.muted }]}>
          {uri ? (
            <Image source={{ uri }} style={styles.thumbImg} />
          ) : (
            <Feather name="box" size={22} color={colors.mutedForeground} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={[styles.name, { color: colors.foreground }]}
            numberOfLines={2}
          >
            {item.name}
          </Text>
          <Text style={[styles.code, { color: colors.mutedForeground }]}>
            {item.code}
          </Text>
          <Text style={[styles.price, { color: colors.primary }]}>
            {formatRupiah(item.price)}
          </Text>
          {stock != null ? (
            <Text style={[styles.stock, { color: colors.mutedForeground }]}>
              Stok: {stock}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => onSend(item)}
          disabled={sendingId === item.id}
          style={[styles.sendBtn, { backgroundColor: colors.primary }]}
        >
          {sendingId === item.id ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Feather name="send" size={16} color={colors.primaryForeground} />
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <View style={[styles.search, { backgroundColor: colors.secondary }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder="Cari produk / kode"
            placeholderTextColor={colors.mutedForeground}
            value={query}
            onChangeText={setQuery}
          />
        </View>
        <TouchableOpacity
          onPress={() => setInStockOnly((v) => !v)}
          style={[
            styles.stockToggle,
            {
              backgroundColor: inStockOnly ? colors.primary : colors.secondary,
            },
          ]}
        >
          <Feather
            name="check"
            size={14}
            color={inStockOnly ? colors.primaryForeground : colors.mutedForeground}
          />
          <Text
            style={[
              styles.stockToggleText,
              {
                color: inStockOnly
                  ? colors.primaryForeground
                  : colors.mutedForeground,
              },
            ]}
          >
            Ada stok
          </Text>
        </TouchableOpacity>
      </View>

      {categories.length > 0 ? (
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[null, ...categories]}
          keyExtractor={(c) => c ?? "__all"}
          contentContainerStyle={styles.catRow}
          renderItem={({ item: c }) => {
            const active = category === c;
            return (
              <TouchableOpacity
                onPress={() => setCategory(c)}
                style={[
                  styles.catChip,
                  {
                    backgroundColor: active ? colors.primary : colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.catText,
                    {
                      color: active
                        ? colors.primaryForeground
                        : colors.foreground,
                    },
                  ]}
                >
                  {c ?? "Semua"}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      ) : null}

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => String(p.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Tidak ada produk.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    paddingBottom: 6,
    alignItems: "center",
  },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, fontFamily: "Inter_400Regular", fontSize: 15 },
  stockToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
  },
  stockToggleText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  catRow: { paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
  catChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  catText: { fontFamily: "Inter_500Medium", fontSize: 12 },
  list: { padding: 12, paddingTop: 6, paddingBottom: 48 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImg: { width: "100%", height: "100%" },
  name: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  code: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 1 },
  price: { fontFamily: "Inter_700Bold", fontSize: 14, marginTop: 3 },
  stock: { fontFamily: "Inter_400Regular", fontSize: 11, marginTop: 1 },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 32,
  },
});
