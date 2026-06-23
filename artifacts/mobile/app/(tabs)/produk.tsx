import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useCallback, useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useListProducts,
  getListProductsQueryKey,
  type Product,
} from "@workspace/api-client-react";

import { ChannelSwitcher } from "@/components/ChannelSwitcher";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ProductListSkeleton } from "@/components/Skeleton";
import { formatRupiah } from "@/components/chat-info/shared";
import { ProductDetailModal } from "@/components/products/ProductDetailModal";
import { ProductFilterBar } from "@/components/products/ProductFilterBar";
import { productStock, useProductFilter } from "@/components/products/useProductFilter";
import { useChannel } from "@/contexts/ChannelContext";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl } from "@/lib/api";

type Colors = ReturnType<typeof useColors>;

// Memoized product card — keeps unchanged rows from re-rendering while typing in
// the filter or when the list query refreshes.
function ProductRowBase({
  item,
  colors,
  onPress,
}: {
  item: Product;
  colors: Colors;
  onPress: (p: Product) => void;
}) {
  const uri = resolveMediaUrl(item.imageUrl);
  const stock = productStock(item);
  const inStock = stock > 0;
  return (
    <TouchableOpacity
      style={[styles.card, { borderColor: colors.border, backgroundColor: colors.card }]}
      activeOpacity={0.7}
      onPress={() => onPress(item)}
    >
      <View style={[styles.thumb, { backgroundColor: colors.muted }]}>
        {uri ? (
          <Image
            source={{ uri }}
            recyclingKey={uri}
            cachePolicy="memory-disk"
            transition={120}
            contentFit="cover"
            style={styles.thumbImg}
          />
        ) : (
          <Feather name="box" size={22} color={colors.mutedForeground} />
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={2}>
          {item.name}
        </Text>
        <View style={styles.metaRow}>
          <Text style={[styles.code, { color: colors.mutedForeground }]}>{item.code}</Text>
          {item.category ? (
            <View style={[styles.catChip, { backgroundColor: colors.primarySoft }]}>
              <Text style={[styles.catText, { color: colors.primaryDark }]} numberOfLines={1}>
                {item.category}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.price, { color: colors.primary }]}>
          {formatRupiah(item.price)}
        </Text>
      </View>
      <View style={styles.rightCol}>
        <View
          style={[
            styles.stockBadge,
            { backgroundColor: inStock ? colors.successSoft : colors.destructive + "22" },
          ]}
        >
          <Text
            style={[
              styles.stockBadgeText,
              { color: inStock ? colors.success : colors.destructive },
            ]}
          >
            {inStock ? stock : 0}
          </Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

const ProductRow = React.memo(ProductRowBase, (prev, next) => {
  const a = prev.item;
  const b = next.item;
  return (
    prev.colors === next.colors &&
    prev.onPress === next.onPress &&
    a.id === b.id &&
    a.name === b.name &&
    a.code === b.code &&
    a.category === b.category &&
    a.price === b.price &&
    a.imageUrl === b.imageUrl &&
    productStock(a) === productStock(b)
  );
});

export default function ProdukScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activeChannelId } = useChannel();

  const { data: products, isLoading } = useListProducts({
    query: {
      queryKey: getListProductsQueryKey(),
      enabled: activeChannelId != null,
    },
  });
  const filter = useProductFilter(products);
  const [selected, setSelected] = useState<Product | null>(null);

  const renderItem = useCallback(
    ({ item }: { item: Product }) => (
      <ProductRow item={item} colors={colors} onPress={setSelected} />
    ),
    [colors],
  );
  const keyExtractor = useCallback((p: Product) => String(p.id), []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Produk" right={<ChannelSwitcher />} />
      <ProductFilterBar state={filter} />

      {isLoading ? (
        <ProductListSkeleton />
      ) : (
        <FlatList
          data={filter.filtered}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 24 }}
          removeClippedSubviews
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          ListHeaderComponent={
            <Text style={[styles.count, { color: colors.mutedForeground }]}>
              {filter.filtered.length} produk
            </Text>
          }
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              Tidak ada produk yang cocok.
            </Text>
          }
        />
      )}

      <ProductDetailModal product={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  count: { fontFamily: "Inter_500Medium", fontSize: 12, paddingHorizontal: 4, paddingBottom: 8 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImg: { width: "100%", height: "100%" },
  name: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 },
  code: { fontFamily: "Inter_400Regular", fontSize: 12 },
  catChip: { paddingHorizontal: 8, paddingVertical: 1, borderRadius: 10, maxWidth: 120 },
  catText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  price: { fontFamily: "Inter_700Bold", fontSize: 15, marginTop: 4 },
  rightCol: { alignItems: "center", gap: 6 },
  stockBadge: {
    minWidth: 30,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    alignItems: "center",
  },
  stockBadgeText: { fontFamily: "Inter_700Bold", fontSize: 12 },
  empty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    paddingVertical: 40,
  },
});
