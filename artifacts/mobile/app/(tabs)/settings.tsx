import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar } from "@/components/Avatar";
import { useAuth } from "@/contexts/AuthContext";
import { useChannel } from "@/contexts/ChannelContext";
import { type ThemePreference, useTheme } from "@/contexts/ThemeContext";
import { useColors } from "@/hooks/useColors";
import { resolveMediaUrl, uploadProfilePhoto } from "@/lib/api";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { value: "light", label: "Terang", icon: "sun" },
  { value: "dark", label: "Gelap", icon: "moon" },
  { value: "system", label: "Sistem", icon: "smartphone" },
];

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, signOut, refreshUser } = useAuth();
  const { channels, activeChannel, setActiveChannelId } = useChannel();
  const { preference, setPreference } = useTheme();
  const [uploading, setUploading] = useState(false);

  const onChangePhoto = async () => {
    if (uploading) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Izin diperlukan", "Beri akses galeri untuk mengganti foto.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    setUploading(true);
    try {
      await uploadProfilePhoto({
        uri: asset.uri,
        name: asset.fileName || `avatar-${Date.now()}.jpg`,
        type: asset.mimeType || "image/jpeg",
      });
      await refreshUser();
    } catch (e: any) {
      Alert.alert("Gagal mengunggah", e?.message ?? "Coba lagi.");
    } finally {
      setUploading(false);
    }
  };

  const confirmSignOut = () => {
    Alert.alert("Keluar", "Anda yakin ingin keluar dari akun ini?", [
      { text: "Batal", style: "cancel" },
      { text: "Keluar", style: "destructive", onPress: () => signOut() },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, backgroundColor: colors.header },
        ]}
      >
        <Text style={[styles.headerTitle, { color: colors.headerForeground }]}>
          Pengaturan
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}>
        <View style={styles.profile}>
          <TouchableOpacity
            onPress={onChangePhoto}
            disabled={uploading}
            activeOpacity={0.8}
          >
            <Avatar
              name={user?.name || user?.email || "?"}
              uri={resolveMediaUrl(user?.profilePhotoUrl)}
              size={72}
            />
            <View style={[styles.photoBadge, { backgroundColor: colors.primary, borderColor: colors.background }]}>
              {uploading ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="camera" size={14} color={colors.primaryForeground} />
              )}
            </View>
          </TouchableOpacity>
          <Text style={[styles.profileName, { color: colors.foreground }]}>
            {user?.name || "Pengguna"}
          </Text>
          <Text style={[styles.profileEmail, { color: colors.mutedForeground }]}>
            {user?.email}
          </Text>
          {user?.companyName ? (
            <View style={[styles.companyChip, { backgroundColor: colors.secondary }]}>
              <Feather name="briefcase" size={13} color={colors.mutedForeground} />
              <Text style={[styles.companyText, { color: colors.foreground }]}>
                {user.companyName}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          TAMPILAN
        </Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.themeRow}>
            {THEME_OPTIONS.map((opt) => {
              const active = preference === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[
                    styles.themeOption,
                    {
                      backgroundColor: active ? colors.primary : colors.secondary,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => setPreference(opt.value)}
                >
                  <Feather
                    name={opt.icon}
                    size={18}
                    color={active ? colors.primaryForeground : colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.themeLabel,
                      { color: active ? colors.primaryForeground : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
          CHANNEL
        </Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {channels.length === 0 ? (
            <Text style={[styles.muted, { color: colors.mutedForeground }]}>
              Belum ada channel.
            </Text>
          ) : (
            channels.map((c, i) => (
              <TouchableOpacity
                key={c.id}
                style={[
                  styles.channelRow,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                ]}
                onPress={() => setActiveChannelId(c.id)}
              >
                <View style={[styles.channelDot, { backgroundColor: c.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.channelLabel, { color: colors.foreground }]}>
                    {c.label}
                  </Text>
                  <Text style={[styles.channelSub, { color: colors.mutedForeground }]}>
                    {c.kind}
                    {c.ownerPhone ? ` · ${c.ownerPhone}` : ""} · {c.status}
                  </Text>
                </View>
                {activeChannel?.id === c.id ? (
                  <Feather name="check-circle" size={20} color={colors.primary} />
                ) : null}
              </TouchableOpacity>
            ))
          )}
        </View>

        <TouchableOpacity
          style={[styles.logout, { borderColor: colors.destructive }]}
          onPress={confirmSignOut}
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>
            Keluar
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 20 },
  profile: { alignItems: "center", paddingVertical: 28, gap: 6 },
  photoBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  profileName: { fontFamily: "Inter_700Bold", fontSize: 20, marginTop: 8 },
  profileEmail: { fontFamily: "Inter_400Regular", fontSize: 14 },
  companyChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    marginTop: 6,
  },
  companyText: { fontFamily: "Inter_500Medium", fontSize: 13 },
  sectionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    paddingHorizontal: 20,
    paddingBottom: 8,
    paddingTop: 8,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  muted: { fontFamily: "Inter_400Regular", fontSize: 14, padding: 16 },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  channelDot: { width: 12, height: 12, borderRadius: 6 },
  channelLabel: { fontFamily: "Inter_600SemiBold", fontSize: 15 },
  channelSub: { fontFamily: "Inter_400Regular", fontSize: 12, marginTop: 2 },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 28,
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
  },
  logoutText: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  themeRow: { flexDirection: "row", gap: 8, padding: 12 },
  themeOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  themeLabel: { fontFamily: "Inter_500Medium", fontSize: 13 },
});
