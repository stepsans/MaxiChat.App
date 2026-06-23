import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  useListProducts,
  useSendProductToChat,
  getGetChatQueryKey,
  type Product,
} from "@workspace/api-client-react";

import { ProductFilterBar } from "@/components/products/ProductFilterBar";
import { productStock, useProductFilter } from "@/components/products/useProductFilter";
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

  const filter = useProductFilter(products);
  const [sendingId, setSendingId] = useState<number | null>(null);

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
    const stock = productStock(item);
    return (
      <View style={[styles.card, { borderColor: colors.border }]}>
        <View style={[styles.thumb, { backgroundColor: colors.muted }]}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.thumbImg}
              recyclingKey={uri}
              cachePolicy="memory-disk"
              transition={120}
              contentFit="cover"
            />
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
          <Text
            style={[
              styles.stock,
              { color: stock > 0 ? colors.success : colors.destructive },
            ]}
          >
            Stok: {stock}
          </Text>
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
      <ProductFilterBar state={filter} compact />

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={filter.filtered}
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
  list: { padding: 12, paddingTop: 8, paddingBottom: 48 },
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
  stock: { fontFamily: "Inter_500Medium", fontSize: 11, marginTop: 1 },
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
