import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import React, { useState } from "react";
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Product } from "@workspace/api-client-react";

import { formatRupiah } from "@/components/chat-info/shared";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl } from "@/lib/api";
import { productStock } from "./useProductFilter";

/**
 * Full product detail sheet. Shows only customer-safe + agent fields
 * (name/code/category/price/stock/media links) — internal tier prices
 * (priceSilver/Gold/Platinum/Reseller/Distributor) are never rendered.
 *
 * Optional `onSend` / `onAddOrder` render the in-chat actions; omit them in the
 * standalone Produk tab where there is no active conversation.
 */
export function ProductDetailModal({
  product,
  onClose,
  onSend,
  onAddOrder,
}: {
  product: Product | null;
  onClose: () => void;
  onSend?: (p: Product) => void;
  onAddOrder?: (p: Product) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [lightbox, setLightbox] = useState(false);

  if (!product) return null;
  const uri = resolveMediaUrl(product.imageUrl);
  const stock = productStock(product);
  const inStock = stock > 0;

  const links: { label: string; url: string; icon: keyof typeof Feather.glyphMap }[] = [];
  if (product.productUrl) links.push({ label: "Halaman produk", url: product.productUrl, icon: "external-link" });
  if (product.flyerUrl) links.push({ label: "Flyer", url: product.flyerUrl, icon: "image" });
  for (const v of product.videoUrls ?? []) links.push({ label: "Video", url: v, icon: "play-circle" });

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 },
          ]}
        >
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <View style={styles.topRow}>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
              {product.name}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Feather name="x" size={24} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
            <Pressable
              onPress={() => uri && setLightbox(true)}
              style={[styles.hero, { backgroundColor: colors.muted }]}
            >
              {uri ? (
                <Image
                  source={{ uri }}
                  style={styles.heroImg}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                />
              ) : (
                <Feather name="box" size={48} color={colors.mutedForeground} />
              )}
            </Pressable>

            <View style={styles.metaRow}>
              <Text style={[styles.code, { color: colors.mutedForeground }]}>
                {product.code}
              </Text>
              {product.category ? (
                <View style={[styles.catChip, { backgroundColor: colors.primarySoft }]}>
                  <Text style={[styles.catText, { color: colors.primaryDark }]}>
                    {product.category}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text style={[styles.price, { color: colors.primary }]}>
              {formatRupiah(product.price)}
            </Text>

            <View
              style={[
                styles.stockPill,
                { backgroundColor: inStock ? colors.successSoft : colors.destructive + "22" },
              ]}
            >
              <View
                style={[
                  styles.stockDot,
                  { backgroundColor: inStock ? colors.success : colors.destructive },
                ]}
              />
              <Text
                style={[
                  styles.stockText,
                  { color: inStock ? colors.success : colors.destructive },
                ]}
              >
                {inStock ? `Stok: ${stock}` : "Stok habis"}
              </Text>
            </View>

            {product.description ? (
              <Text style={[styles.description, { color: colors.foreground }]}>
                {product.description}
              </Text>
            ) : null}

            {links.length > 0 ? (
              <View style={styles.linkWrap}>
                {links.map((l, i) => (
                  <TouchableOpacity
                    key={`${l.url}-${i}`}
                    style={[styles.linkBtn, { borderColor: colors.border }]}
                    onPress={() => Linking.openURL(l.url).catch(() => {})}
                  >
                    <Feather name={l.icon} size={16} color={colors.primary} />
                    <Text style={[styles.linkText, { color: colors.foreground }]}>
                      {l.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}
          </ScrollView>

          {onSend || onAddOrder ? (
            <View style={styles.actions}>
              {onSend ? (
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: colors.primary }]}
                  onPress={() => onSend(product)}
                >
                  <Feather name="send" size={16} color={colors.primaryForeground} />
                  <Text style={[styles.actionText, { color: colors.primaryForeground }]}>
                    Kirim ke Chat
                  </Text>
                </TouchableOpacity>
              ) : null}
              {onAddOrder ? (
                <TouchableOpacity
                  style={[styles.actionBtn, styles.actionOutline, { borderColor: colors.primary }]}
                  onPress={() => onAddOrder(product)}
                >
                  <Feather name="plus" size={16} color={colors.primary} />
                  <Text style={[styles.actionText, { color: colors.primary }]}>
                    Tambah ke Order
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      <Modal visible={lightbox} transparent animationType="fade" onRequestClose={() => setLightbox(false)}>
        <Pressable style={styles.lightbox} onPress={() => setLightbox(false)}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.lightboxImg}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          ) : null}
          <View style={[styles.lightboxClose, { top: insets.top + 12 }]}>
            <Feather name="x" size={28} color="#fff" />
          </View>
        </Pressable>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    maxHeight: "90%",
  },
  handleRow: { alignItems: "center", paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  topRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 12 },
  title: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 18 },
  hero: {
    width: "100%",
    height: 220,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  heroImg: { width: "100%", height: "100%" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 },
  code: { fontFamily: "Inter_500Medium", fontSize: 13 },
  catChip: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  catText: { fontFamily: "Inter_600SemiBold", fontSize: 12 },
  price: { fontFamily: "Inter_700Bold", fontSize: 24, marginTop: 8 },
  stockPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    marginTop: 10,
  },
  stockDot: { width: 8, height: 8, borderRadius: 4 },
  stockText: { fontFamily: "Inter_600SemiBold", fontSize: 13 },
  description: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 16,
  },
  linkWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 },
  linkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  linkText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  actions: { flexDirection: "row", gap: 10, paddingTop: 10 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 48,
    borderRadius: 12,
  },
  actionOutline: { backgroundColor: "transparent", borderWidth: 1.5 },
  actionText: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  lightbox: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  lightboxImg: { width: "100%", height: "100%" },
  lightboxClose: { position: "absolute", right: 16 },
});
